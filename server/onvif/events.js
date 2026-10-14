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
    // The xml2js parser sometimes hands back a real boolean already. Coercing
    // that through Number() turns `false` into 0 and loses the state flag
    // entirely — observed on a UNIX IPM32R32P NVR, where every MotionAlarm
    // arrived as State:0 with no usable state.
    if (typeof value === 'boolean') { /* already the right type */ }
    else if (value === 'true') value = true;
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
 * Wrap a library callback so it is invoked AT MOST ONCE and can never throw
 * out into the library's HTTP response handler — a throw there is an uncaught
 * exception with no try/catch anywhere above it, i.e. a dead server. Returns a
 * callable no-op when no function was supplied, so the library's unconditional
 * `callback.call(...)` always dereferences a real function.
 */
function safeCallback(fn) {
  if (typeof fn !== 'function') return () => {};
  let called = false;
  return function guardedCallback(...args) {
    if (called) return;
    called = true;
    try { fn.apply(this, args); } catch { /* the library's own callback threw */ }
  };
}

/** First function argument, wrapped — the callback position is not fixed. */
function pickCallback(args) {
  return safeCallback(args.find((a) => typeof a === 'function'));
}

/** First plain-object argument, or {} — the options position is not fixed. */
function pickOptions(args) {
  return args.find((a) => a !== null && typeof a === 'object') ?? {};
}

/**
 * Stop the `onvif` library from killing the process.
 *
 * The library's `Cam.prototype.unsubscribe = function(callback)` takes exactly
 * one argument, but its own pull loop calls it as `unsubscribe({}, cb)`
 * (events.js ~385) and as `unsubscribe()` (~346/395). Forwarding those shapes
 * verbatim makes the library capture `{}` as its callback and throw
 * `TypeError: callback.call is not a function` (events.js:309) ASYNCHRONOUSLY,
 * inside the HTTP response handler — observed in production. No caller-side
 * try/catch can ever see that throw, so the only fix is normalization: the
 * original must always receive exactly one argument, a function.
 *
 * The same normalization also covers the case where the subscription is
 * already gone and the original throws SYNCHRONOUSLY ('You should create
 * pull-point subscription first!') from inside the pull loop's response
 * handler — again uncatchable upstream. Budget cameras whose pull-point
 * subscriptions lapse hit this routinely.
 *
 * `renew(options, callback)` and `pullMessages(options, callback)` share the
 * pattern: both are called by the library with an options object first, both
 * throw synchronously when the subscription lapsed mid-pull, both invoke
 * `callback.call(...)` unconditionally in their response handlers (so a
 * missing or misplaced callback is an async TypeError), and both run library-
 * internal callbacks that can throw themselves (`_terminationTime(data)` on a
 * malformed renew response, for one). Guard all three on the instance.
 */
export function guardUnsubscribe(cam) {
  if (!cam || cam.__unsubscribeGuarded) return;

  const originalUnsubscribe = cam.unsubscribe;
  if (typeof originalUnsubscribe === 'function') {
    cam.unsubscribe = function guardedUnsubscribe(...args) {
      const callback = pickCallback(args);

      if (!this.events?.subscription?.subscriptionReference?.address) {
        callback.call(this, null, null, null);   // nothing to unsubscribe from; this is not an error
        return undefined;
      }
      try {
        // Exactly one argument, always a function: never let the library see
        // the `{}` its own call sites pass in the callback's place.
        return originalUnsubscribe.call(this, callback);
      } catch (err) {
        callback.call(this, err, null, null);
        return undefined;
      }
    };
  }

  for (const name of ['renew', 'pullMessages']) {
    const original = cam[name];
    if (typeof original !== 'function') continue;
    cam[name] = function guardedOptionsFirst(...args) {
      const callback = pickCallback(args);
      const options = pickOptions(args);
      try {
        // Always (optionsObject, callbackFunction), whatever shape arrived:
        // `renew(cb)` / `pullMessages(cb)` would otherwise leave the library's
        // callback undefined and its options a function, and `renew()` /
        // `pullMessages()` would crash its unconditional `callback.call`.
        return original.call(this, options, callback);
      } catch (err) {
        callback.call(this, err, null, null);
        return undefined;
      }
    };
  }

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

/** Exposed for tests: the value coercion that a live NVR proved subtle. */
export const __testing = { readItems };
