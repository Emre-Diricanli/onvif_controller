import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

process.env.FFMPEG_PATH = fileURLToPath(new URL('../fake-ffmpeg.mjs', import.meta.url));
const { StreamHandle, startStream, getStream, stopStream, stopAllForSession } = await import('../../server/stream/pipeline.js');
const { fetchSnapshot } = await import('../../server/stream/snapshot.js');
const profile = {
  token: 'main', rtspUri: 'rtsp://test-user:test-password@127.0.0.1/live',
  video: { codec: 'H264', width: 3840, height: 2160, fps: 15 },
};
const session = { id: 'stream-test', profileMap: new Map([['main', profile]]) };
const handles = new Set();
let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}
function handleFor(video = profile.video) {
  const handle = new StreamHandle(session, { ...profile, video });
  handles.add(handle);
  return handle;
}
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await sleep(10);
  }
}
async function stop(handle) {
  const child = handle.child;
  const closed = child && once(child, 'close');
  handle.stop();
  if (closed) await closed;
}
function timerCapture(fn) {
  const original = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  try { fn(); } finally { globalThis.setTimeout = original; }
  return timers;
}
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
let server;
try {
  process.env.FAKE_FFMPEG_MODE = 'fixture';
  const info = await startStream(session, 'main');
  const live = getStream(info.streamId);
  handles.add(live);
  live.addViewer();
  const argv = live.child.spawnargs;
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  check('RTSP input is bounded and H264 is copied', () => {
    for (const [flag, expected] of Object.entries({
      '-rtsp_transport': 'tcp', '-timeout': '5000000', '-analyzeduration': '1000000',
      '-probesize': '2000000', '-fflags': 'nobuffer', '-flags': 'low_delay',
      '-avoid_negative_ts': 'make_zero', '-c:v': 'copy',
    })) assert.equal(value(flag), expected);
    for (const flag of ['-timeout', '-analyzeduration', '-probesize', '-fflags', '-flags']) {
      assert.ok(argv.indexOf(flag) < argv.indexOf('-i'));
    }
    assert.equal(live.initTimeoutMs, 20000);
    assert.equal(handleFor({ ...profile.video, width: 1920, height: 1080 }).initTimeoutMs, 12000);
  });
  await until(() => live.gopCache.length >= 3);
  check('GOP cache starts at a keyframe and includes following fragments', () => {
    assert.equal(live.gopCache[0].readUInt32BE(live.gopCache[0].length - 4), 1);
    assert.equal(live.gopCache[1].readUInt32BE(live.gopCache[1].length - 4), 2);
  });
  const cachedInit = live.initSegment;
  const [keyframe, dependent] = live.gopCache;
  const cache = handleFor();
  cache.consume(cachedInit);
  cache.consume(dependent);
  check('a late stream never caches a dependent frame before a keyframe', () => assert.deepEqual(cache.gopCache, []));
  cache.consume(keyframe);
  for (let i = 0; i < 300; i += 1) cache.consume(dependent);
  cache.consume(dependent);
  check('an oversized GOP is discarded until the next keyframe', () => assert.deepEqual(cache.gopCache, []));
  cache.consume(keyframe);
  check('cache resumes at a keyframe after reaching its bound', () => assert.equal(cache.gopCache.length, 1));
  cache.stop();
  await until(() => live.gopCache[0]?.readUInt32BE(live.gopCache[0].length - 4) === 6);
  check('a new keyframe replaces the previous GOP', () => assert.equal(live.gopCache.length, 1));
  stopStream(info.streamId);

  const hevc = handleFor({ codec: 'H265', width: 3840, height: 2160, fps: 60 });
  hevc.spawn();
  check('HEVC transcodes within output geometry/fps/GOP limits', () => {
    assert.deepEqual([hevc.info.transcoding, hevc.info.width, hevc.info.height, hevc.info.fps], [true, 1920, 1080, 30]);
    const args = hevc.child.spawnargs;
    const get = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(get('-c:v'), 'libx264');
    assert.equal(get('-preset'), 'veryfast');
    assert.equal(get('-tune'), 'zerolatency');
    assert.match(get('-vf'), /scale=.*1920/);
    assert.equal(get('-r'), '30');
    assert.equal(get('-g'), '60');
    assert.equal(get('-pix_fmt'), 'yuv420p');
    assert.equal(hevc.initTimeoutMs, 20000);
    const slow = handleFor({ codec: 'HEVC', width: 641, height: 359, fps: 12.5 });
    assert.deepEqual([slow.info.width, slow.info.height, slow.info.fps], [640, 358, 12.5]);
  });
  await stop(hevc);

  const policy = handleFor();
  const originalRandom = Math.random;
  let timers;
  const events = [];
  policy.on('degraded', () => events.push('degraded'));
  policy.on('error', () => events.push('error'));
  try {
    Math.random = () => 0;
    timers = timerCapture(() => {
      policy.onUnexpectedExit(1, null);
      policy.onUnexpectedExit(1, null);
      policy.onUnexpectedExit(1, null);
      policy.onUnexpectedExit(1, null);
    });
    check('failure backoff is 1s, 2s then continuing 20s degraded probes', () => {
      assert.deepEqual(timers.map((timer) => timer.delay), [1000, 2000, 20000, 20000]);
      assert.deepEqual(events, ['error', 'error', 'degraded']);
    });
    policy.degraded = false;
    policy.failures = 2;
    policy.initializedAt = Date.now() - 31000;
    events.length = 0;
    timers = timerCapture(() => policy.onUnexpectedExit(1, null));
    check('a healthy run resets the streak and restarts quietly', () => {
      assert.equal(policy.failures, 0);
      assert.equal(timers[0].delay, 1000);
      assert.deepEqual(events, []);
    });
    policy.initializedAt = null;
    Math.random = () => 0.5;
    timers = timerCapture(() => policy.onUnexpectedExit(1, null));
    check('retries have bounded jitter', () => assert.equal(timers[0].delay, 1100));
  } finally { Math.random = originalRandom; }
  policy.stop();

  /* Drive real crash processes while explicitly advancing just the retry timer.
   * The captured delays above verify production timing without a minute-long
   * sleep in every run of the regression suite. */
  const recovery = handleFor();
  recovery.addViewer();
  let initCount = 0;
  recovery.on('init', () => { initCount += 1; });
  recovery.spawn();
  await until(() => initCount === 1);
  process.env.FAKE_FFMPEG_MODE = 'crash';
  const firstClose = once(recovery.child, 'close');
  recovery.child.kill('SIGKILL');
  await firstClose;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    clearTimeout(recovery.restartTimer);
    recovery.spawn();
    await once(recovery.child, 'close');
  }
  check('repeated process exits degrade but keep a background retry', () => {
    assert.equal(recovery.degraded, true);
    assert.ok(recovery.restartTimer);
    assert.equal(recovery.stopped, false);
    assert.ok(recovery.restartTimer._idleTimeout >= 20000);
  });
  process.env.FAKE_FFMPEG_MODE = 'fixture';
  const retry = recovery.restartTimer._onTimeout;
  clearTimeout(recovery.restartTimer);
  retry();
  await until(() => initCount === 2);
  check('background retry emits a fresh init and leaves degraded state', () => {
    assert.equal(recovery.degraded, false);
    assert.equal(recovery.initTimer, null);
  });
  await stop(recovery);
  check('stop clears retry/deadline timers and cached fragments', () => {
    assert.equal(recovery.restartTimer, null);
    assert.equal(recovery.initTimer, null);
    assert.deepEqual(recovery.gopCache, []);
  });

  process.env.FAKE_FFMPEG_MODE = 'slowinit';
  const hung = handleFor();
  hung.initTimeoutMs = 150;
  hung.spawn();
  const hungChild = hung.child;
  await once(hungChild, 'close');
  check('retry initialization deadline kills ffmpeg', () => assert.equal(hungChild.signalCode, 'SIGKILL'));
  hung.stop();
  const normal = { ...profile, video: { ...profile.video, width: 1920, height: 1080 } };
  const timeoutSession = { id: 'timeout-test', profileMap: new Map([['main', normal]]) };
  const spawnOriginal = StreamHandle.prototype.spawn;
  let startupChild;
  StreamHandle.prototype.spawn = function () {
    spawnOriginal.call(this);
    startupChild = this.child;
  };
  try {
    await assert.rejects(startStream(timeoutSession, 'main'), (error) => error.code === 'STREAM_FAILED' && /Timed out/.test(error.message));
    await until(() => startupChild.signalCode !== null);
    check('HTTP startup timeout rejects and kills its child', () => assert.equal(startupChild.signalCode, 'SIGKILL'));
  } finally { StreamHandle.prototype.spawn = spawnOriginal; }

  const diagnostic = handleFor();
  diagnostic.profile = { ...diagnostic.profile, rtspUri: `${profile.rtspUri}?password=query-secret` };
  diagnostic.consumeStats('connection failed rtsp://private-user:private-');
  diagnostic.logInitTimeout();
  diagnostic.consumeStats('password@camera/live\n');
  diagnostic.consumeStats('https://another-user:another-password@camera/snapshot\n');
  diagnostic.consumeStats('rtsp://incomplete:secret');
  diagnostic.flushStderr();
  diagnostic.logExit(1, null);
  assert.equal(diagnostic.stderrTail[0], 'connection failed rtsp://***');
  assert.equal(diagnostic.stderrTail.length, 3);
  for (let i = 0; i < 20; i += 1) diagnostic.consumeStats(`error ${i}\n`);
  diagnostic.logExit(1, null);
  check('stderr lines are bounded and split credentials never reach logs', () => {
    assert.equal(diagnostic.stderrTail.length, 12);
    const logs = warnings.join('\n');
    assert.doesNotMatch(logs, /test-password|fixture-password|private-password|another-password|incomplete:secret|query-secret/);
    assert.doesNotMatch(logs, /fixture-user|private-user|another-user/);
  });

  delete process.env.FAKE_FFMPEG_MODE;
  process.env.FAKE_FFMPEG_SOURCE = 'testsrc2=size=640x360:rate=10';
  const real = handleFor({ codec: 'H265', width: 3840, height: 2160, fps: 10 });
  real.spawn();
  await until(() => real.gopCache.length >= 2, 10000);
  check('real ffmpeg output updates geometry and yields a keyframe GOP', () => {
    assert.deepEqual([real.info.width, real.info.height], [640, 360]);
    assert.match(real.mime, /avc1\./);
    assert.equal(real.gopCache[0].toString('ascii', 4, 8), 'moof');
    const decode = spawnSync(process.env.FAKE_FFMPEG_REAL || '/opt/homebrew/bin/ffmpeg',
      ['-v', 'error', '-xerror', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'],
      { input: Buffer.concat([real.initSegment, ...real.gopCache]), timeout: 5000 });
    assert.equal(decode.status, 0, decode.stderr.toString());
  });
  await stop(real);

  process.env.FAKE_FFMPEG_MODE = 'fixture';
  const abandonedInfo = await startStream(session, 'main');
  const abandoned = getStream(abandonedInfo.streamId);
  handles.add(abandoned);
  abandoned.addViewer();
  const abandonedClose = once(abandoned.child, 'close');
  abandoned.child.kill('SIGKILL');
  await abandonedClose;
  abandoned.removeViewer();
  const expireGrace = abandoned.orphanTimer._onTimeout;
  clearTimeout(abandoned.orphanTimer);
  expireGrace();
  check('viewer grace expiry removes a failed stream and cancels background retry', () => {
    assert.equal(getStream(abandoned.streamId), undefined);
    assert.equal(abandoned.stopped, true);
    assert.equal(abandoned.restartTimer, null);
  });

  let requests = 0;
  let active = 0;
  let peak = 0;
  server = createServer((req, res) => {
    requests += 1;
    active += 1;
    peak = Math.max(peak, active);
    res.on('close', () => { active -= 1; });
    if (req.url === '/hang') return;
    if (req.url === '/bodyhang') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.write(Buffer.from([0xff, 0xd8]));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }, 70);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const snapshotProfile = { snapshotUri: `http://127.0.0.1:${server.address().port}/jpeg` };
  const snapshotSession = { profileMap: new Map([['main', snapshotProfile]]) };
  const results = await Promise.all(Array.from({ length: 20 }, () => fetchSnapshot(snapshotSession, 'main')));
  check('concurrent snapshot viewers share a single request and JPEG', () => {
    assert.equal(requests, 1);
    assert.equal(peak, 1);
    assert.ok(results.every((result) => result === results[0]));
  });
  await fetchSnapshot(snapshotSession, 'main');
  check('recent snapshot is cached', () => assert.equal(requests, 1));
  await sleep(320);
  await fetchSnapshot(snapshotSession, 'main');
  check('expired snapshot refreshes', () => assert.equal(requests, 2));
  for (const path of ['/hang', '/bodyhang']) {
    snapshotProfile.snapshotUri = `http://127.0.0.1:${server.address().port}${path}`;
    const started = Date.now();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => fetchSnapshot(snapshotSession, 'main')));
    check(`${path} times out once for all concurrent viewers`, () => {
      assert.ok(outcomes.every((result) => result.status === 'rejected' && result.reason.code === 'DEVICE_TIMEOUT'));
      assert.ok(Date.now() - started < 4500);
    });
  }
  console.log(`${checks} stream checks passed`);
} finally {
  console.warn = originalWarn;
  for (const handle of handles) await stop(handle);
  stopAllForSession(session.id);
  stopAllForSession('timeout-test');
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  delete process.env.FAKE_FFMPEG_MODE;
  delete process.env.FAKE_FFMPEG_SOURCE;
}
