import { EventEmitter } from 'node:events';
import { asArray } from './util.js';

/**
 * Turn an ONVIF topic into something an operator can scan in a live feed.
 * "tns1:RuleEngine/CellMotionDetector/Motion" -> "Motion"
 */
function shortTopic(topic) {
  const raw = String(topic ?? '');
  const last = raw.split('/').pop() ?? raw;
  return last.replace(/^[a-z0-9]+:/i, '') || raw;
}

function readTopic(message) {
  const topic = message?.topic?._ ?? message?.topic?.$?.Dialect ?? message?.topic;
  if (typeof topic === 'string') return topic;
  if (topic && typeof topic === 'object') return String(topic._ ?? '');
  return '';
}

/** SimpleItem lists arrive as either a single object or an array of them. */
function readItems(node) {
  const out = {};
  for (const item of asArray(node?.simpleItem)) {
    const name = item?.$?.Name ?? item?.name;
    if (!name) continue;
    let value = item?.$?.Value ?? item?.value;
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value !== '' && value !== undefined && !Number.isNaN(Number(value))) value = Number(value);
    out[name] = value;
  }
  for (const item of asArray(node?.elementItem)) {
    const name = item?.$?.Name;
    if (name) out[name] = item;
  }
  return out;
}

function normalizeMessage(raw) {
  const message = raw?.message?.message ?? raw?.message ?? raw;
  const topic = readTopic(raw);
  const data = readItems(message?.data);
  const source = readItems(message?.source);

  // Most boolean detectors report a single State/IsMotion style flag; surface it
  // as `state` so the UI can render start/stop without knowing every topic.
  let state = null;
  for (const key of ['IsMotion', 'State', 'IsTamper', 'IsSoundDetected', 'LogicalState', 'Value']) {
    if (typeof data[key] === 'boolean') { state = data[key]; break; }
  }

  const utc = message?.$?.UtcTime ?? message?.utcTime;
  return {
    type: 'event',
    topic,
    shortTopic: shortTopic(topic),
    utcTime: utc ? new Date(utc).toISOString() : new Date().toISOString(),
    source,
    data,
    state,
  };
}

/**
 * Attach a pull-point subscription to a session.
 *
 * The `onvif` library starts its own pull loop as soon as an 'event' listener is
 * added and renews the subscription internally, so the job here is normalizing
 * the payloads and reporting subscription health honestly to the UI.
 */

/**
 * Stop the `onvif` library from killing the process.
 *
 * On a failed PullMessages the library calls `this.unsubscribe({}, cb)` from
 * inside its own event loop (events.js ~385). If the subscription was already
 * torn down, `Cam.unsubscribe` throws SYNCHRONOUSLY — from a callback, with no
 * promise and no try/catch anywhere above it — so it surfaces as an uncaught
 * exception and takes the whole server down mid-stream. Budget cameras whose
 * pull-point subscriptions lapse hit this routinely.
 *
 * Guard the method on the instance so the throw never happens. Also normalize
 * the library's own inconsistent call shape: it documents `unsubscribe(cb)` but
 * calls it as `unsubscribe({}, cb)`.
 */
export function guardUnsubscribe(cam) {
  if (!cam || cam.__unsubscribeGuarded) return;
  const original = cam.unsubscribe;

  cam.unsubscribe = function guardedUnsubscribe(...args) {
    const callback = args.find((a) => typeof a === 'function');
    const done = (err) => {
      if (typeof callback === 'function') {
        try { callback.call(this, err ?? null, null, null); } catch { /* the library's own callback threw */ }
      }
    };

    if (!this.events?.subscription?.subscriptionReference?.address) {
      done(null);   // nothing to unsubscribe from; this is not an error
      return;
    }
    try {
      return original.apply(this, args);
    } catch (err) {
      done(err);
      return undefined;
    }
  };

  cam.__unsubscribeGuarded = true;
}

export function attachEvents(session) {
  guardUnsubscribe(session.cam);

  const bus = session.events instanceof EventEmitter ? session.events : new EventEmitter();
  bus.setMaxListeners(50);
  if (session.eventsAttached) return bus;
  session.eventsAttached = true;

  let attempt = 0;

  const onEvent = (raw) => {
    attempt = 0;
    if (!bus.subscribed) {
      bus.subscribed = true;
      bus.emit('lifecycle', { type: 'subscribed' });
    }
    try {
      bus.emit('event', normalizeMessage(raw));
    } catch {
      // A single malformed message must never tear down the subscription.
    }
  };

  const onError = (err) => {
    bus.subscribed = false;
    attempt += 1;
    bus.emit('lifecycle', {
      type: attempt <= 5 ? 'resubscribing' : 'error',
      attempt,
      code: 'DEVICE_ERROR',
      message: attempt <= 5
        ? 'Event subscription dropped; reconnecting.'
        : `Event subscription failed ${attempt} times: ${String(err?.message ?? err).slice(0, 200)}`,
    });
  };

  session.cam.on('event', onEvent);
  session.cam.on('eventsError', onError);
  // The library emits plain 'error' for pull failures on some versions.
  session.cam.on('error', onError);

  bus.detach = () => {
    session.cam.removeListener('event', onEvent);
    session.cam.removeListener('eventsError', onError);
    session.cam.removeListener('error', onError);
    session.eventsAttached = false;
    bus.subscribed = false;
    try {
      if (session.cam.events?.subscription) session.cam.unsubscribe(() => {});
    } catch { /* the device may already be gone */ }
  };

  return bus;
}
