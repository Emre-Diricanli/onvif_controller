/**
 * Per-resource mutual exclusion protects read-modify-write across sessions.
 * Hold this lock while awaiting governed requests, never the reverse: a lock
 * does not consume a governor slot while another writer finishes its work.
 */
import { AppError } from '../errors.js';

const locks = new Map();

export function lockKey(host, port, resource) {
  return `${String(host).toLowerCase()}:${port ?? ''}|${resource}`;
}

/** Snapshot only; callers cannot mutate live queues. Keys may contain resources. */
export function lockStats() {
  return [...locks].map(([key, lock]) => ({ key, active: true, queued: lock.queue.length }));
}

export async function withResourceLock(key, fn, { waitMs } = {}) {
  if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 0x7fffffff)) {
    throw new AppError('BAD_REQUEST', 'The resource lock wait deadline is invalid.');
  }
  let lock = locks.get(key);
  if (!lock) {
    lock = { queue: [] };
    locks.set(key, lock);
  } else {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null, expiresAt: waitMs === undefined ? Infinity : Date.now() + waitMs };
      const expire = () => {
        const index = lock.queue.indexOf(waiter);
        if (index !== -1) lock.queue.splice(index, 1);
        reject(new AppError('DEVICE_BUSY', 'The device resource is busy; its lock wait deadline was exceeded.'));
      };
      waiter.expire = expire;
      lock.queue.push(waiter);
      if (waitMs !== undefined) waiter.timer = setTimeout(expire, waitMs);
    });
  }
  try {
    return await fn();
  } finally {
    // Timed-out waiters are removed immediately, even if the owner never ends.
    // Check time here too: a busy event loop may delay a deadline's timer.
    let next;
    while ((next = lock.queue.shift())) {
      clearTimeout(next.timer);
      if (next.expiresAt <= Date.now()) { next.expire(); continue; }
      next.resolve();
      break;
    }
    if (!next) locks.delete(key);
  }
}
