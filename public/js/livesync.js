// livesync.js — pure live-edge and recovery decisions for the MSE player.
//
// Everything in this file is deliberately free of DOM, MediaSource and timer
// APIs so it can be unit-tested in plain Node (tools/tests/player.mjs).
// player.js measures the real numbers, feeds them in, and applies whatever
// comes back.

// How far behind the buffered live edge the playhead should ride. Low enough
// to feel live, high enough to absorb one fragment's worth of jitter without
// starving the decoder.
export const LIVE_TARGET_LATENCY_S = 0.7;

// Catch-up ceiling. 15% is fast enough to reel in drift and slow enough that
// motion never reads as sped up.
export const LIVE_MAX_RATE = 1.15;

// Lag at which catch-up saturates at LIVE_MAX_RATE; between the target and
// this the rate scales proportionally.
export const LIVE_FULL_RATE_LAG_S = 2.0;

// Beyond this much lag, rate catch-up would take tens of seconds to converge —
// the viewer watches stale video the whole time. Hard-seek instead. This is
// also the path a backgrounded tab takes when it becomes visible again.
export const LIVE_HARD_SEEK_LAG_S = 3.0;

// Hard seeks land slightly behind the edge, never on it: the edge moves while
// the seek settles, and landing past the last buffered frame is a stall.
export const LIVE_SEEK_BACK_S = 0.35;

/**
 * Decide how the playhead should track the buffered live edge.
 *
 * @param {{ currentTime: number, bufferedEnd: number, hidden?: boolean }} input
 *   currentTime   video.currentTime in seconds
 *   bufferedEnd   end of the last buffered range in seconds (the live edge)
 *   hidden        page is not visible — catch-up is pointless work there
 * @returns {{ playbackRate: number, seekTo: number|null }}
 *   seekTo is null unless a hard seek is warranted.
 */
export function decideLiveSync({ currentTime, bufferedEnd, hidden = false } = {}) {
  if (hidden) return { playbackRate: 1, seekTo: null };
  // NaN and Infinity show up before metadata loads and when a buffer was just
  // torn down; the only safe answer is "do nothing".
  if (!Number.isFinite(currentTime) || !Number.isFinite(bufferedEnd)) {
    return { playbackRate: 1, seekTo: null };
  }
  const lag = bufferedEnd - currentTime;
  if (lag > LIVE_HARD_SEEK_LAG_S) {
    return { playbackRate: 1, seekTo: Math.max(0, bufferedEnd - LIVE_SEEK_BACK_S) };
  }
  // On target, or ahead of it (negative lag — the edge estimate lags the
  // playhead): play at normal speed. There is no slow-down path; running
  // slightly hot self-corrects at the next fragment.
  if (lag <= LIVE_TARGET_LATENCY_S) {
    return { playbackRate: 1, seekTo: null };
  }
  const span = LIVE_FULL_RATE_LAG_S - LIVE_TARGET_LATENCY_S;
  const t = Math.min(1, (lag - LIVE_TARGET_LATENCY_S) / span);
  return { playbackRate: 1 + (LIVE_MAX_RATE - 1) * t, seekTo: null };
}

/**
 * Locate the jump target when the playhead sits outside every buffered range.
 *
 * @param {Array<[number, number]>} ranges  buffered [start, end] pairs
 * @param {number} currentTime
 * @returns {number|null} the nearest range start AHEAD of the playhead, or
 *   null when the playhead is inside a range or has simply run out of buffer
 *   at the live edge (waiting for data is the right answer there — jumping
 *   ahead would land past the last frame and stall). Going backwards is never
 *   offered: it replays video the viewer already saw.
 */
export function findGapJumpTarget(ranges, currentTime, epsilon = 0.05) {
  if (!Array.isArray(ranges) || !Number.isFinite(currentTime)) return null;
  let best = null;
  for (const range of ranges) {
    if (!Array.isArray(range)) continue;
    const [start, end] = range;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // "Inside" includes a small tolerance past the end: sitting exactly at a
    // range's end means starved at the edge, not stranded in a gap.
    if (currentTime >= start - epsilon && currentTime <= end + epsilon) return null;
    if (start > currentTime + epsilon && (best === null || start < best)) best = start;
  }
  return best;
}

// Backoff for automatically retrying live video while degraded to snapshots:
// generous enough that a camera rebooting or an ffmpeg restart loop has time
// to settle, capped so a camera that came back is never more than a minute
// away from live video.
export const RECOVERY_BACKOFF_MS = [15_000, 30_000, 60_000];

/**
 * Delay before the n-th (0-based) background recovery attempt. Attempts past
 * the end of the schedule hold at the cap; garbage input gets the first delay.
 */
export function recoveryBackoffMs(attempt) {
  if (!Number.isFinite(attempt) || attempt < 0) return RECOVERY_BACKOFF_MS[0];
  return RECOVERY_BACKOFF_MS[Math.min(Math.floor(attempt), RECOVERY_BACKOFF_MS.length - 1)];
}
