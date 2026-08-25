import { FanoutDispatcher } from './delivery.js';
import { buildPayload, signPayload } from './payload.js';

/**
 * Bridge the per-session ONVIF event bus onto the webhook dispatcher.
 *
 * This is the only place the three fan-out pieces meet: payload.js shapes and
 * signs, delivery.js queues and sends, and this module decides which events go
 * where and cleans up when the session ends.
 *
 * Lifetime is the SESSION, not the browser tab — but also not longer. When the
 * operator disconnects, delivery stops. FANOUT.md is explicit that this is a
 * bridge and not a durable subscriber, and the README must not imply otherwise.
 */

/** A target with no filters receives everything. */
function matchesFilters(target, payload) {
  const filters = target.filters;
  if (!Array.isArray(filters) || filters.length === 0) return true;
  const topic = String(payload.topic ?? '').toLowerCase();
  return filters.some((filter) => {
    const needle = String(filter ?? '').toLowerCase();
    if (!needle) return false;
    // A filter matches either the normalized class exactly, or any substring of
    // the raw vendor topic — so an operator can write "motion" or the literal
    // "RuleEngine/CellMotionDetector" and have both behave sensibly.
    return needle === String(payload.class ?? '').toLowerCase() || topic.includes(needle);
  });
}

/**
 * Serialize once, then sign the exact bytes that will be sent. Signing a
 * re-serialized object would produce a signature the receiver cannot verify,
 * because key order and number formatting are not guaranteed to round-trip.
 */
function prepareFor(target, payload) {
  if (!matchesFilters(target, payload)) return null;

  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-Onvif-Event-Id': payload.id,
    'X-Onvif-Timestamp': String(Math.floor(Date.parse(payload.receivedAt) / 1000)),
    'User-Agent': 'onvif-controller-fanout/1',
  };
  if (target.secret) headers['X-Onvif-Signature'] = signPayload(body, target.secret);

  return { id: payload.id, headers, body };
}

/**
 * Attach fan-out to a live session.
 *
 * Returns a detach function. Safe to call when there are no targets — it
 * simply does nothing, so callers need no conditional.
 */
export function attachFanout(session, targets, { attachSnapshot = null, hooks = {} } = {}) {
  const enabled = (targets ?? []).filter((t) => t && t.enabled !== false);
  if (enabled.length === 0 || !session?.events) return () => {};

  const dispatcher = new FanoutDispatcher(hooks);
  dispatcher.setTargets(enabled);

  const onEvent = (event) => {
    // Nothing in here may throw. This runs inside the ONVIF event listener, and
    // an exception would propagate into the library's pull loop — the exact
    // failure that already cost us a process crash once (see guardUnsubscribe
    // in server/onvif/events.js).
    try {
      const payload = buildPayload(session, event, { profileToken: event?.profileToken ?? null });

      if (typeof attachSnapshot !== 'function') {
        dispatcher.dispatch(payload, prepareFor);
        return;
      }

      // Enrich then dispatch exactly ONCE. Dispatching immediately and again
      // after the snapshot arrives would deliver every event twice, which no
      // receiver can dedupe cleanly since both copies share an id.
      //
      // The wait is bounded by the snapshot layer's own timeout, and any
      // failure resolves to the un-enriched payload — so a dead snapshot
      // endpoint costs latency on that target, never the event itself.
      Promise.resolve()
        .then(() => attachSnapshot(session, payload))
        .catch(() => payload)
        .then((enriched) => dispatcher.dispatch(enriched ?? payload, prepareFor));
    } catch {
      // A malformed event must not tear down the subscription.
    }
  };

  session.events.on('event', onEvent);

  return () => {
    session.events.removeListener('event', onEvent);
    dispatcher.close();
  };
}

export { FanoutDispatcher };
