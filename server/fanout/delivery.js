import { EventEmitter } from 'node:events';

/**
 * Webhook delivery: bounded queue, bounded concurrency, retry, circuit breaker.
 *
 * The governing constraint is that a camera in a motion storm must never be
 * able to harm the app. Every mechanism here is a bound, not a feature:
 *
 *   - the queue drops rather than grows, so memory is capped
 *   - concurrency is capped, so a slow receiver cannot consume every socket
 *   - each request has a hard timeout, so a hung receiver cannot pin a slot
 *   - a failing target trips a breaker, so a dead edge box is not hammered
 *
 * Loss is acceptable here; silent loss is not. Everything dropped is counted
 * and readable through stats(), per FANOUT.md "Delivery semantics".
 */

const DEFAULTS = {
  queueSize: 100,
  concurrency: 4,
  timeoutMs: 10000,
  maxAttempts: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 8000,
  breakerThreshold: 5,
  breakerCooldownMs: 30000,
};

/** Retry only what might succeed on a retry. */
function isRetryable(status) {
  // A 4xx means the receiver looked at the payload and rejected it. Retrying
  // is pointless and, for a misconfigured target, indistinguishable from a
  // deliberate flood. 408 and 429 are the two exceptions: both explicitly
  // invite a later attempt.
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/**
 * Exponential backoff with full jitter. Jitter matters more than it looks:
 * a recorder emitting one event per channel across 32 channels would otherwise
 * retry all 32 in lockstep and arrive as a synchronized burst.
 */
function backoffFor(attempt, { baseBackoffMs, maxBackoffMs }, random = Math.random) {
  const ceiling = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  // Never let a pending backoff hold the process open at shutdown.
  timer.unref?.();
  signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * One target's delivery pipeline. Created per configured webhook URL, not per
 * event, so the queue, breaker state and counters persist across events.
 */
export class TargetDeliverer extends EventEmitter {
  constructor(target, { send = defaultSend, now = () => Date.now(), random = Math.random } = {}) {
    super();
    this.target = target;
    this.options = { ...DEFAULTS, ...(target.delivery ?? {}) };
    this.send = send;
    this.now = now;
    this.random = random;

    this.queue = [];
    this.inFlight = 0;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.closed = false;

    this.counters = {
      enqueued: 0,
      delivered: 0,
      failed: 0,
      droppedQueueFull: 0,
      droppedBreakerOpen: 0,
      retries: 0,
      breakerTrips: 0,
    };
    this.lastError = null;
    this.lastDeliveryAt = null;
  }

  get breakerOpen() {
    return this.now() < this.openUntil;
  }

  /**
   * Accept an event for delivery. Never throws and never blocks: an event bus
   * callback must not be able to fail because a webhook is unhealthy.
   */
  enqueue(payload) {
    if (this.closed) return false;

    if (this.breakerOpen) {
      this.counters.droppedBreakerOpen += 1;
      return false;
    }

    if (this.queue.length >= this.options.queueSize) {
      // Drop the OLDEST, not the newest. Under sustained pressure the recent
      // events are the ones an operator still cares about; the backlog is
      // already stale by the time we are this far behind.
      this.queue.shift();
      this.counters.droppedQueueFull += 1;
    }

    this.queue.push(payload);
    this.counters.enqueued += 1;
    this.#pump();
    return true;
  }

  #pump() {
    while (!this.closed && this.inFlight < this.options.concurrency && this.queue.length > 0) {
      const payload = this.queue.shift();
      this.inFlight += 1;
      // Deliberately not awaited: #pump must stay synchronous so enqueue()
      // returns immediately to the event bus.
      this.#deliver(payload)
        .catch(() => { /* #deliver never rejects; this is belt-and-braces */ })
        .finally(() => {
          this.inFlight -= 1;
          if (!this.closed) this.#pump();
        });
    }
  }

  async #deliver(payload) {
    const { maxAttempts, timeoutMs } = this.options;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.closed) return;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();

      try {
        const result = await this.send(this.target, payload, controller.signal);
        clearTimeout(timer);

        if (result.ok) {
          this.#onSuccess();
          this.emit('delivered', { id: payload.id, status: result.status, attempt });
          return;
        }

        if (!isRetryable(result.status) || attempt === maxAttempts) {
          this.#onFailure(`HTTP ${result.status}`);
          this.emit('failed', { id: payload.id, status: result.status, attempt, retryable: isRetryable(result.status) });
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err);
        if (attempt === maxAttempts) {
          this.#onFailure(reason);
          this.emit('failed', { id: payload.id, error: reason, attempt });
          return;
        }
      }

      this.counters.retries += 1;
      await sleep(backoffFor(attempt, this.options, this.random));
    }
  }

  #onSuccess() {
    this.counters.delivered += 1;
    this.consecutiveFailures = 0;
    this.lastDeliveryAt = new Date(this.now()).toISOString();
  }

  #onFailure(reason) {
    this.counters.failed += 1;
    this.lastError = String(reason).slice(0, 200);
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.options.breakerThreshold) {
      this.openUntil = this.now() + this.options.breakerCooldownMs;
      this.counters.breakerTrips += 1;
      this.consecutiveFailures = 0;
      // Everything already queued is undeliverable for the cooldown, and
      // holding it would only deliver a burst of stale events when the
      // breaker closes. Drop it, counted.
      this.counters.droppedBreakerOpen += this.queue.length;
      this.queue.length = 0;
      this.emit('breaker-open', { until: new Date(this.openUntil).toISOString(), reason: this.lastError });
    }
  }

  stats() {
    return {
      id: this.target.id,
      queued: this.queue.length,
      inFlight: this.inFlight,
      breakerOpen: this.breakerOpen,
      breakerOpenUntil: this.breakerOpen ? new Date(this.openUntil).toISOString() : null,
      lastDeliveryAt: this.lastDeliveryAt,
      // The receiver's error text, not a password or URL — safe to surface.
      lastError: this.lastError,
      ...this.counters,
    };
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    this.removeAllListeners();
  }
}

/**
 * The default transport. Signing happens in payload.js and is passed in as
 * prepared headers, so this function never sees a secret.
 */
async function defaultSend(target, payload, signal) {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: payload.headers,
    body: payload.body,
    signal,
    redirect: 'error', // A redirect could point anywhere; refuse rather than follow it off-target.
  });
  return { ok: response.ok, status: response.status };
}

/**
 * Fan one event out across every enabled target whose filters match.
 * Never throws — the caller is an ONVIF event listener, and a webhook problem
 * must not tear down the camera subscription.
 */
export class FanoutDispatcher {
  constructor({ send, now, random } = {}) {
    this.deliverers = new Map();
    this.hooks = { send, now, random };
  }

  setTargets(targets) {
    const seen = new Set();
    for (const target of targets ?? []) {
      seen.add(target.id);
      const existing = this.deliverers.get(target.id);
      // Reuse the deliverer when only its config changed, so breaker state and
      // counters survive a config reload rather than silently resetting.
      if (existing) existing.options = { ...DEFAULTS, ...(target.delivery ?? {}) };
      else this.deliverers.set(target.id, new TargetDeliverer(target, this.hooks));
    }
    for (const [id, deliverer] of this.deliverers) {
      if (!seen.has(id)) { deliverer.close(); this.deliverers.delete(id); }
    }
  }

  /** `prepare(target, event)` returns { id, headers, body } or null to skip. */
  dispatch(event, prepare) {
    for (const deliverer of this.deliverers.values()) {
      if (deliverer.target.enabled === false) continue;
      try {
        const payload = prepare(deliverer.target, event);
        if (payload) deliverer.enqueue(payload);
      } catch {
        // A payload that cannot be built for one target must not stop the
        // others, and must never propagate into the event subscription.
      }
    }
  }

  stats() {
    return [...this.deliverers.values()].map((d) => d.stats());
  }

  close() {
    for (const deliverer of this.deliverers.values()) deliverer.close();
    this.deliverers.clear();
  }
}

/**
 * Live dispatchers, keyed by session id.
 *
 * The API needs per-target delivery stats, but a dispatcher belongs to a
 * session and routes have no handle on one. This registry is the seam: the
 * bridge registers on attach and unregisters on detach, so stats reflect only
 * sessions that actually exist.
 */
const activeDispatchers = new Map();

export function registerDispatcher(sessionId, dispatcher) {
  activeDispatchers.set(sessionId, dispatcher);
}

export function unregisterDispatcher(sessionId) {
  activeDispatchers.delete(sessionId);
}

/**
 * Aggregate stats across every live session, merged per target id — an
 * operator cares that "the edge webhook" is healthy, not which browser
 * session happened to deliver.
 */
export function getDeliveryStats(targetId = null) {
  const merged = new Map();

  for (const dispatcher of activeDispatchers.values()) {
    for (const stat of dispatcher.stats()) {
      if (targetId && stat.id !== targetId) continue;
      const existing = merged.get(stat.id);
      if (!existing) { merged.set(stat.id, { ...stat, sessions: 1 }); continue; }

      existing.sessions += 1;
      for (const key of ['enqueued', 'delivered', 'failed', 'droppedQueueFull', 'droppedBreakerOpen', 'retries', 'breakerTrips', 'queued', 'inFlight']) {
        existing[key] = (existing[key] ?? 0) + (stat[key] ?? 0);
      }
      // A target is unhealthy if it is open anywhere, and the most recent
      // error is the useful one to surface.
      existing.breakerOpen = existing.breakerOpen || stat.breakerOpen;
      if (stat.lastError) existing.lastError = stat.lastError;
      if (stat.lastDeliveryAt && (!existing.lastDeliveryAt || stat.lastDeliveryAt > existing.lastDeliveryAt)) {
        existing.lastDeliveryAt = stat.lastDeliveryAt;
      }
    }
  }

  const all = [...merged.values()];
  return targetId ? (all[0] ?? null) : all;
}

export const __testing = { backoffFor, isRetryable, DEFAULTS, activeDispatchers };
