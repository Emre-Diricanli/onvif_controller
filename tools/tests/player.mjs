/**
 * Player unit tests: the pure live-edge and recovery decisions in
 * public/js/livesync.js. No DOM, no servers — these run in plain Node.
 *
 *   - decideLiveSync: on-target lag plays at 1.0; growing lag raises
 *     playbackRate proportionally up to the 1.15 ceiling; past the hard-seek
 *     threshold it seeks to just behind the live edge instead; ahead-of-edge,
 *     empty-buffer, NaN and hidden-tab inputs are all safe no-ops.
 *   - findGapJumpTarget: inside a range and starved-at-the-edge do nothing;
 *     before the first range or stranded in a gap jumps forward to the
 *     nearest range start.
 *   - recoveryBackoffMs: 15s, 30s, 60s, capped at 60s, garbage-safe.
 */
import {
  decideLiveSync,
  findGapJumpTarget,
  recoveryBackoffMs,
  LIVE_TARGET_LATENCY_S,
  LIVE_MAX_RATE,
  LIVE_FULL_RATE_LAG_S,
  LIVE_HARD_SEEK_LAG_S,
  LIVE_SEEK_BACK_S,
  RECOVERY_BACKOFF_MS,
} from '../../public/js/livesync.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- decideLiveSync: on target ---
{
  const d = decideLiveSync({ currentTime: 10, bufferedEnd: 10 + LIVE_TARGET_LATENCY_S });
  check('on-target lag plays at 1.0', d.playbackRate === 1 && d.seekTo === null, JSON.stringify(d));
  const under = decideLiveSync({ currentTime: 10, bufferedEnd: 10 + LIVE_TARGET_LATENCY_S - 0.01 });
  check('just under target plays at 1.0', under.playbackRate === 1 && under.seekTo === null, JSON.stringify(under));
}

// --- decideLiveSync: proportional catch-up ---
{
  const slight = decideLiveSync({ currentTime: 10, bufferedEnd: 11.0 }); // lag 1.0
  check('slightly behind: rate above 1 and under the ceiling',
    slight.playbackRate > 1 && slight.playbackRate < LIVE_MAX_RATE && slight.seekTo === null,
    JSON.stringify(slight));
  const more = decideLiveSync({ currentTime: 10, bufferedEnd: 11.5 }); // lag 1.5
  check('rate increases with lag', more.playbackRate > slight.playbackRate,
    `${slight.playbackRate} vs ${more.playbackRate}`);
  const full = decideLiveSync({ currentTime: 10, bufferedEnd: 10 + LIVE_FULL_RATE_LAG_S });
  check('rate saturates at the ceiling', Math.abs(full.playbackRate - LIVE_MAX_RATE) < 1e-9,
    String(full.playbackRate));
  const pastFull = decideLiveSync({ currentTime: 10, bufferedEnd: 10 + LIVE_HARD_SEEK_LAG_S - 0.01 });
  check('rate never exceeds the ceiling below the hard-seek threshold',
    pastFull.playbackRate <= LIVE_MAX_RATE && pastFull.seekTo === null, JSON.stringify(pastFull));
}

// --- decideLiveSync: hard seek ---
{
  const far = decideLiveSync({ currentTime: 10, bufferedEnd: 10 + LIVE_HARD_SEEK_LAG_S + 5 });
  check('far behind seeks instead of speeding up',
    far.seekTo !== null && far.playbackRate === 1, JSON.stringify(far));
  check('the seek lands just behind the live edge',
    Math.abs(far.seekTo - (18 - LIVE_SEEK_BACK_S)) < 1e-9, String(far.seekTo));
  const nearZero = decideLiveSync({ currentTime: 0, bufferedEnd: LIVE_HARD_SEEK_LAG_S + 0.1 });
  check('a seek never targets a negative time', nearZero.seekTo >= 0, String(nearZero.seekTo));
}

// --- decideLiveSync: edge cases ---
{
  const ahead = decideLiveSync({ currentTime: 12, bufferedEnd: 10 });
  check('ahead of the edge is a no-op at 1.0', ahead.playbackRate === 1 && ahead.seekTo === null);
  for (const [name, input] of [
    ['NaN currentTime', { currentTime: NaN, bufferedEnd: 10 }],
    ['NaN bufferedEnd', { currentTime: 5, bufferedEnd: NaN }],
    ['missing bufferedEnd', { currentTime: 5 }],
    ['undefined input', undefined],
    ['infinite edge', { currentTime: 5, bufferedEnd: Infinity }],
  ]) {
    const d = decideLiveSync(input);
    check(`${name} is a safe no-op`, d.playbackRate === 1 && d.seekTo === null, JSON.stringify(d));
  }
  const hidden = decideLiveSync({ currentTime: 0, bufferedEnd: 600, hidden: true });
  check('hidden tab: no catch-up, no seek', hidden.playbackRate === 1 && hidden.seekTo === null);
}

// --- findGapJumpTarget ---
{
  check('inside a range: no jump', findGapJumpTarget([[10, 20]], 15) === null);
  check('at a range end (starved edge): no jump', findGapJumpTarget([[10, 20]], 20) === null);
  check('past the last range: no jump', findGapJumpTarget([[10, 20]], 25) === null);
  check('before the first range: jump to its start', findGapJumpTarget([[10, 20]], 4) === 10);
  check('in a gap: jump to the next range start', findGapJumpTarget([[10, 12], [15, 20]], 13) === 15);
  check('in a gap: picks the nearest ahead, not a later one',
    findGapJumpTarget([[10, 12], [15, 20], [30, 40]], 13) === 15);
  check('unsorted ranges still find the nearest ahead',
    findGapJumpTarget([[30, 40], [10, 12], [15, 20]], 13) === 15);
  check('empty ranges: no jump', findGapJumpTarget([], 5) === null);
  check('NaN playhead: no jump', findGapJumpTarget([[10, 20]], NaN) === null);
  check('non-array ranges: no jump', findGapJumpTarget(null, 5) === null);
}

// --- recoveryBackoffMs ---
{
  check('schedule is 15s, 30s, 60s',
    RECOVERY_BACKOFF_MS[0] === 15_000 && RECOVERY_BACKOFF_MS[1] === 30_000 && RECOVERY_BACKOFF_MS[2] === 60_000);
  check('attempt 0 waits 15s', recoveryBackoffMs(0) === 15_000);
  check('attempt 1 waits 30s', recoveryBackoffMs(1) === 30_000);
  check('attempt 2 waits 60s', recoveryBackoffMs(2) === 60_000);
  check('attempts past the end hold at the cap',
    recoveryBackoffMs(3) === 60_000 && recoveryBackoffMs(100) === 60_000);
  check('negative and NaN attempts get the first delay',
    recoveryBackoffMs(-1) === 15_000 && recoveryBackoffMs(NaN) === 15_000);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
