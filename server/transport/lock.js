/**
 * Per-(device, resource) mutual exclusion for read-modify-write (ADAPTERS.md §7).
 *
 * The governor bounds how many requests a device sees; it does not stop two
 * sessions each reading the same config object and overwriting the other's
 * change. This does. It is deliberately NOT a governor slot: hold the lock
 * while awaiting governed requests, never the reverse, or the two deadlock.
 *
 * Step-0 reference implementation; the transport stream owns hardening
 * (wait deadlines, stats).
 */
const tails = new Map();

export function lockKey(host, port, resource) {
  return `${String(host).toLowerCase()}:${port ?? ''}|${resource}`;
}

export async function withResourceLock(key, fn) {
  const previous = tails.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
