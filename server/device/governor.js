/**
 * Per-host device governor.
 *
 * A recorder is a scarce resource with a hard concurrency budget, not a web
 * service. `192.168.15.101` (AR504-32) wedged under repeated probing — ONVIF and
 * RTSP both stopped answering while its TCP listener kept accepting — because
 * many independent code paths each behaved as if they were its only client.
 *
 * Every outbound request to a device passes through here. See GOVERNOR.md.
 *
 * Keyed by HOST, not by session: two browser sessions pointed at the same
 * recorder share that recorder's firmware session cap, so a per-session limit
 * would not have prevented the wedge.
 */

import { AppError } from '../errors.js';

export const DEFAULTS = {
  concurrency: 2,          // in flight per host
  minSpacingMs: 40,        // floor between starts, so bursts cannot become storms
  deadlineMs: 20000,       // a queued request that waits longer fails honestly
  breakerThreshold: 5,     // consecutive transport failures before opening
  breakerCooldownMs: 30000,
  // Two is the observed signature, not a guess: on the AR504-32 the port kept
  // accepting while ONVIF and RTSP each stopped answering. Two protocols timing
  // out consecutively against a host that is still accepting connections is the
  // wedge; one is just a slow request.
  wedgeTimeouts: 2,
};

/** Interactive work must not queue behind a bulk capability walk. */
export const PRIORITY = { interactive: 0, normal: 5, bulk: 9 };

/**
 * A timeout is the wedge signature; a refusal or reset is not. A device that
 * actively refuses is answering — it is simply saying no, and that must not be
 * mistaken for the silent-but-listening failure we are guarding against.
 */
function isTimeout(err) {
  const code = err?.code ?? '';
  if (code === 'DEVICE_TIMEOUT' || code === 'ETIMEDOUT') return true;
  return /timed? ?out|did not answer/i.test(String(err?.message ?? ''));
}

class HostGovernor {
  constructor(host, options = {}, hooks = {}) {
    this.host = host;
    // Accept the shorter aliases too: `failureThreshold`/`cooldownMs` read
    // better at call sites and are what the behavior tests use.
    const { failureThreshold, cooldownMs, ...rest } = options ?? {};
    this.options = {
      ...DEFAULTS,
      ...rest,
      ...(failureThreshold === undefined ? {} : { breakerThreshold: failureThreshold }),
      ...(cooldownMs === undefined ? {} : { breakerCooldownMs: cooldownMs }),
    };
    this.now = hooks.now ?? (() => Date.now());
    this.setTimer = hooks.setTimer ?? ((fn, ms) => setTimeout(fn, ms));

    this.queue = [];
    this.inFlight = 0;
    this.spacingTimer = null;
    this.deadlineTimer = null;
    this.halfOpenProbeInFlight = false;
    this.lastStartedAt = 0;
    this.consecutiveFailures = 0;
    this.consecutiveTimeouts = 0;
    this.openUntil = 0;
    this.wedged = false;
    this.wedgeReason = null;
    this.counters = { submitted: 0, completed: 0, failed: 0, rejected: 0, timedOutInQueue: 0 };
  }

  get breakerOpen() {
    return this.now() < this.openUntil;
  }

  /**
   * Run `fn` under this host's budget. Never retries: a retry is a decision for
   * the caller, who knows whether the operation is safe to repeat. Retrying
   * inside the governor is how a storm starts.
   */
  submit(fn, { priority = PRIORITY.normal, deadlineMs = this.options.deadlineMs, label = '' } = {}) {
    this.counters.submitted += 1;

    if (this.wedged) {
      this.counters.rejected += 1;
      return Promise.reject(new AppError('DEVICE_BUSY',
        `${this.host} has stopped responding.`,
        `${this.wedgeReason} The device is accepting connections but not answering; it usually needs a power cycle.`));
    }
    if (this.breakerOpen) {
      this.counters.rejected += 1;
      return Promise.reject(new AppError('DEVICE_BUSY',
        `${this.host} is not responding reliably, so requests are paused.`,
        'Repeated failures opened a cooldown. It will retry automatically shortly.'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        fn, priority, resolve, reject, label,
        // Stable insertion order within a priority, so equal-priority work is
        // FIFO rather than arbitrary.
        seq: this.counters.submitted,
        expiresAt: this.now() + deadlineMs,
      });
      // A deadline must fire even if nothing else ever pumps the queue — with a
      // full concurrency budget and a slow in-flight request, no other event
      // would wake it and the caller would wait forever instead of being told
      // the device is busy.
      this.#armDeadline();
      this.#pump();
    });
  }

  /** Wake at the earliest queued deadline so expiry never depends on other traffic. */
  #armDeadline() {
    if (this.deadlineTimer || this.queue.length === 0) return;
    const earliest = Math.min(...this.queue.map((i) => i.expiresAt));
    const wait = Math.max(0, earliest - this.now());
    this.deadlineTimer = this.setTimer(() => {
      this.deadlineTimer = null;
    this.halfOpenProbeInFlight = false;
      this.#pump();
      this.#armDeadline();
    }, wait);
  }

  #nextIndex() {
    let best = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i];
      if (best === -1) { best = i; continue; }
      const b = this.queue[best];
      if (item.priority < b.priority || (item.priority === b.priority && item.seq < b.seq)) best = i;
    }
    return best;
  }

  #pump() {
    // Drop anything that expired while queued before considering new work: a
    // caller who has already given up must not consume the device's budget.
    const now = this.now();
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].expiresAt <= now) {
        const [expired] = this.queue.splice(i, 1);
        this.counters.timedOutInQueue += 1;
        expired.reject(new AppError('DEVICE_BUSY',
          `${this.host} is busy and the request timed out while waiting.`,
          'The device is answering slowly. Try again in a moment.'));
      }
    }

    // Half-open: once the cooldown has passed, admit exactly ONE probe rather
    // than releasing the whole queue at a device that may still be unhealthy.
    // Flooding it the instant the timer expires is how a recovering device gets
    // knocked over again.
    const halfOpen = this.openUntil > 0 && !this.breakerOpen && this.consecutiveFailures === 0;
    const cap = halfOpen ? 1 : this.options.concurrency;
    if (halfOpen && (this.halfOpenProbeInFlight || this.inFlight > 0)) return;

    while (this.inFlight < cap && this.queue.length > 0) {
      const wait = this.options.minSpacingMs - (this.now() - this.lastStartedAt);
      if (wait > 0) {
        // Re-pump after the spacing floor rather than starting early.
        //
        // Deliberately NOT unref'd: this timer owns queued work that has already
        // been promised to a caller. An unref'd timer does not hold the event
        // loop open, so a process with nothing else pending would exit — or a
        // test would hang — with those promises never settling.
        if (this.spacingTimer) return;
        this.spacingTimer = this.setTimer(() => {
          this.spacingTimer = null;
    this.deadlineTimer = null;
    this.halfOpenProbeInFlight = false;
          this.#pump();
        }, wait);
        return;
      }
      const index = this.#nextIndex();
      if (index === -1) return;
      const [item] = this.queue.splice(index, 1);
      this.inFlight += 1;
      if (halfOpen) this.halfOpenProbeInFlight = true;
      this.lastStartedAt = this.now();
      this.#run(item);
      if (halfOpen) return;   // exactly one probe, then wait for its verdict
    }
  }

  async #run(item) {
    try {
      const value = await item.fn();
      this.consecutiveFailures = 0;
      this.consecutiveTimeouts = 0;
      // A successful probe closes the breaker for real.
      this.openUntil = 0;
      this.halfOpenProbeInFlight = false;
      this.counters.completed += 1;
      item.resolve(value);
    } catch (err) {
      this.counters.failed += 1;
      this.halfOpenProbeInFlight = false;
      this.#onFailure(err);
      item.reject(err);
    } finally {
      this.inFlight -= 1;
      this.#pump();
    }
  }

  #onFailure(err) {
    this.consecutiveFailures += 1;

    if (isTimeout(err)) {
      this.consecutiveTimeouts += 1;
      // The observed wedge: TCP still connects, but requests stop being
      // answered. Repeated timeouts against a host that is still accepting
      // connections is exactly that signature.
      if (this.consecutiveTimeouts >= this.options.wedgeTimeouts) {
        this.markWedged(`${this.consecutiveTimeouts} consecutive timeouts while the port stayed open.`);
        return;
      }
    } else {
      this.consecutiveTimeouts = 0;
    }

    if (this.consecutiveFailures >= this.options.breakerThreshold) {
      this.openUntil = this.now() + this.options.breakerCooldownMs;
      this.consecutiveFailures = 0;
      this.#drainQueue('Requests were paused after repeated failures.');
    }
  }

  /**
   * Stop all traffic to a host that has stopped answering. Continuing to probe
   * is what deepened the original wedge, so this latches until the operator
   * explicitly clears it.
   */
  markWedged(reason) {
    this.wedged = true;
    this.wedgeReason = reason;
    this.#drainQueue('The device stopped responding.');
  }

  #drainQueue(message) {
    const queued = this.queue.splice(0);
    for (const item of queued) {
      this.counters.rejected += 1;
      item.reject(new AppError('DEVICE_BUSY', `${this.host}: ${message}`, null));
    }
  }

  /** Operator-initiated recovery. Nothing clears a wedge automatically. */
  reset() {
    this.wedged = false;
    this.wedgeReason = null;
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    this.consecutiveTimeouts = 0;
  }

  /**
   * A single string state rather than a set of booleans: the UI needs to render
   * one honest status line, and "half-open" is a real state distinct from both
   * open and closed.
   */
  get breakerState() {
    if (this.wedged) return 'wedged';
    if (this.breakerOpen) return 'open';
    if (this.openUntil > 0) return 'half-open';
    return 'closed';
  }

  /** The UI must be able to say "device busy" rather than appear to hang. */
  stats() {
    return {
      host: this.host,
      queueDepth: this.queue.length,
      queued: this.queue.length,   // retained: existing callers use this name
      inFlight: this.inFlight,
      breakerState: this.breakerState,
      breakerOpen: this.breakerOpen,
      wedged: this.wedged,
      wedgeReason: this.wedgeReason,
      ...this.counters,
    };
  }
}

const governors = new Map();

export function getGovernor(host, options) {
  const key = String(host ?? 'unknown');
  let governor = governors.get(key);
  if (!governor) {
    governor = new HostGovernor(key, options);
    governors.set(key, governor);
  }
  return governor;
}

/**
 * The single entry point every outbound device call goes through.
 * `host` may be undefined on a path that has not been wired yet; such calls run
 * ungoverned rather than failing, so adding the governor cannot break a caller.
 */
export function withGovernor(host, fn, opts) {
  if (!host) return fn();
  return getGovernor(host).submit(fn, opts);
}

export function governorStats(host = null) {
  if (host) return governors.get(String(host))?.stats() ?? null;
  return [...governors.values()].map((g) => g.stats());
}

export function resetGovernor(host) {
  const governor = governors.get(String(host));
  if (governor) governor.reset();
  return governor?.stats() ?? null;
}

export const __testing = { HostGovernor, governors, isTimeout, DEFAULTS, PRIORITY };
