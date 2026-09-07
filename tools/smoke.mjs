/**
 * End-to-end smoke test against the mock ONVIF camera.
 *
 *   node tools/smoke.mjs
 *
 * Boots the mock device and the app server on scratch ports, exercises the
 * documented API surface, and asserts the Definition of Done items from SPEC.md
 * that can be checked without real hardware.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WsClient from 'ws';
import path from 'node:path';
import { describeProfiles, PROFILE_DESCRIPTION_CONCURRENCY } from '../server/onvif/media.js';

const MOCK_PORT = 10199;
const APP_PORT = 8099;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForPort(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.VERBOSE && console.log(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.env.VERBOSE && console.error(`[${name}] ${d}`));
  children.push(child);
  return child;
}

function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function readNdjson(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    if (done) return events;
  }
}

async function profileDescriptionChecks() {
  console.log('\nBounded profile description');
  const raw = Array.from({ length: 12 }, (_, index) => ({
    $: { token: `profile-${index}` },
    name: `Profile ${index}`,
    videoEncoderConfiguration: {
      encoding: 'H264',
      resolution: { width: index % 3 === 0 ? 1920 : 640, height: 480 },
      rateControl: { frameRateLimit: 25, bitrateLimit: 1024 },
    },
    videoSourceConfiguration: { sourceToken: `source-${Math.floor(index / 2)}` },
  }));

  function camera({ failStreamToken = null, profiles = raw } = {}) {
    let active = 0;
    let peak = 0;
    const cam = {
      getProfiles(cb) { cb(null, profiles); },
      getStreamUri({ profileToken }, cb) {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          if (profileToken === failStreamToken) cb(new Error('offline channel'));
          else cb(null, { uri: `rtsp://camera/${profileToken}` });
        }, (12 - Number(profileToken.split('-')[1])) % 5);
      },
      getSnapshotUri({ profileToken }, cb) {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          cb(null, { uri: `http://camera/${profileToken}.jpg` });
        }, Number(profileToken.split('-')[1]) % 4);
      },
    };
    return { cam, peak: () => peak };
  }

  const serialCam = camera();
  const serial = await describeProfiles(serialCam.cam, {
    host: '127.0.0.1', port: 80, username: 'user', password: 'secret', ctx: {}, concurrency: 1,
  });
  const concurrentCam = camera({ failStreamToken: 'profile-7' });
  const progress = [];
  const concurrentWithFailure = await describeProfiles(concurrentCam.cam, {
    host: '127.0.0.1', port: 80, username: 'user', password: 'secret', ctx: {},
    onProgress: (event) => progress.push(event),
  });
  const comparisonCam = camera();
  const concurrent = await describeProfiles(comparisonCam.cam, {
    host: '127.0.0.1', port: 80, username: 'user', password: 'secret', ctx: {},
  });

  check('concurrent descriptions preserve serial profile order',
    JSON.stringify(concurrent.profiles) === JSON.stringify(serial.profiles));
  check('concurrent descriptions preserve serial profileMap order',
    JSON.stringify([...concurrent.profileMap.keys()]) === JSON.stringify([...serial.profileMap.keys()]));
  check('profile URI requests stay within the named concurrency bound',
    comparisonCam.peak() <= PROFILE_DESCRIPTION_CONCURRENCY,
    `peak=${comparisonCam.peak()} limit=${PROFILE_DESCRIPTION_CONCURRENCY}`);
  const failedProfile = concurrentWithFailure.profiles.find((entry) => entry.token === 'profile-7');
  check('a failed stream URI leaves the profile present', Boolean(failedProfile));
  check('a failed stream URI is retained as null rtsp',
    concurrentWithFailure.profileMap.get('profile-7')?.rtspUri === null);
  check('profile progress starts at zero', progress[0]?.completed === 0 && progress[0]?.total === raw.length);
  check('profile progress is monotonic',
    progress.every((event, index) => index === 0 || event.completed >= progress[index - 1].completed));
  check('profile progress terminates at the total',
    progress.at(-1)?.completed === raw.length && progress.at(-1)?.total === raw.length);

  const singleSerial = await describeProfiles(camera({ profiles: raw.slice(0, 2) }).cam, {
    host: '127.0.0.1', port: 80, username: 'user', password: 'secret', ctx: {}, concurrency: 1,
  });
  const singleConcurrent = await describeProfiles(camera({ profiles: raw.slice(0, 2) }).cam, {
    host: '127.0.0.1', port: 80, username: 'user', password: 'secret', ctx: {},
  });
  check('single-camera profile descriptions are unchanged',
    JSON.stringify(singleConcurrent.profiles) === JSON.stringify(singleSerial.profiles)
      && JSON.stringify([...singleConcurrent.profileMap]) === JSON.stringify([...singleSerial.profileMap]));
}

/**
 * Profile G probe checks that need no device at all. The safety properties here
 * matter more than the feature ones: the probe reaches a recorder holding an
 * operator's only copy of their footage, so "never mutates" and "never claims
 * unobserved support" are asserted directly rather than left to review.
 */
async function playbackProbeChecks() {
  console.log('\nPlayback probe (Profile G)');
  const { probePlayback } = await import('../server/onvif/playback.js');
  const { readFile } = await import('node:fs/promises');

  const envelope = { _envelopeHeader: () => '<E>', _envelopeFooter: () => '</E>' };
  const svc = (ns, path) => ({ namespace: `http://www.onvif.org/${ns}/wsdl`, XAddr: `http://192.168.99.9/onvif/${path}` });

  // A camera with no Profile G is a complete answer, not an error.
  const bare = await probePlayback({ cam: { services: [], uri: {}, ...envelope }, host: '10.0.0.1', timeoutMs: 300, sources: [] }, {});
  check('probe on a non-recorder concludes cleanly', /no ONVIF Profile G service/i.test(bare.conclusion));
  check('probe on a non-recorder claims no capability', Object.values(bare.services).every((s) => s.present === false));

  // Every SOAP body the probe sends must be non-mutating.
  const sent = [];
  const recorder = {
    ...envelope,
    services: [svc('ver10/recording', 'recording'), svc('ver10/replay', 'replay'), svc('ver10/search', 'search')],
    uri: {},
    _parseUrl: (u) => new URL(u),
    _request: (opts, cb) => {
      sent.push(opts.body);
      // cam._request hands back raw xml2js output, where every node is an
      // array. Mirror that shape here so this test exercises the same parsing
      // path a real recorder drives.
      if (/FindRecordings|FindEvents/.test(opts.body)) {
        return cb(null, [{ findRecordingsResponse: [{ searchToken: ['TOK-1'] }] }], '');
      }
      if (/GetRecordingSearchResults|GetEventSearchResults/.test(opts.body)) return cb(new Error('search backend offline'));
      return cb(null, [{}], '');
    },
    getRecordingServiceCapabilities: (cb) => cb(null, { dynamicRecordings: false }),
    getRecordingSummary: (cb) => cb(null, { dataFrom: '2026-08-24T00:00:00Z', dataUntil: '2026-08-25T00:00:00Z' }),
    getRecordings: (cb) => cb(null, [{
      recordingToken: 'REC1',
      configuration: { source: { sourceId: 'SRC_CH1', name: 'Front Door' } },
      tracks: { track: [] },
    }]),
    getReplayUri: (_o, cb) => cb(null, { uri: 'rtsp://admin:hunter2@192.168.99.9:554/replay/REC1' }),
  };
  const session = {
    cam: recorder, host: '10.1.10.70', timeoutMs: 500,
    sources: [{ token: 'VideoSource_1', label: 'Channel 1', profiles: [{ token: 'P1' }] }],
  };
  const report = await probePlayback(session, {});

  check('probe issues no mutating recording call',
    !sent.some((body) => /<\s*(?:\w+:)?(Create|Delete|Set|Remove)[A-Za-z]*/.test(body)),
    sent.filter((b) => /<\s*(?:\w+:)?(Create|Delete|Set)/.test(b)).join(' | '));

  // A search that fails midway must still be ended, or the recorder leaks handles.
  const started = sent.filter((b) => /<FindRecordings|<FindEvents/.test(b)).length;
  const ended = sent.filter((b) => /<EndSearch/.test(b)).length;
  check('every opened search is ended even when results fail', started > 0 && ended === started, `started ${started}, ended ${ended}`);

  // The bug this probe exists to catch: recording sources and profile video
  // source tokens live in different namespaces and must never be assumed equal.
  check('mismatched recording source is not silently mapped to a profile', report.channelMapping.derivable === false);
  check('unmapped recording is reported by token', report.channelMapping.unmatchedRecordings.includes('REC1'));
  check('conclusion warns that channel mapping is not derivable', /could not be mapped/i.test(report.conclusion));

  // Credentials must not survive into a report an operator pastes into a ticket.
  const serialized = JSON.stringify(report);
  check('replay URI is redacted in the report', !serialized.includes('hunter2'));

  // Host pinning: a recorder reports its own LAN address, which we cannot reach.
  check('service URL is pinned to the address the operator typed', report.services.recording.url.includes('10.1.10.70'));

  // A step that never ran must not read as a passing step.
  const failedStep = report.steps.find((s) => s.step === 'findRecordings');
  check('a failed search step is reported as failed, not ok', failedStep.status === 'failed', JSON.stringify(failedStep));

  // Regression: the standalone probe CLI must attach host/port to the session
  // before probing. connectDevice does not, so without it every service XAddr
  // was pinned to the literal string "undefined" and every call hung up —
  // exposed by the first real Profile G recorder (AR504-32). Assert the CLI
  // still does this rather than silently regressing.
  const cli = await readFile(new URL('../tools/probe-playback.mjs', import.meta.url), 'utf8');
  check('the probe CLI attaches host to the session before probing',
    /session\.host\s*=\s*options\.host/.test(cli), 'session.host assignment missing — XAddrs would pin to undefined');
}

/**
 * Fan-out delivery guarantees. These are bounds, not features: a camera in a
 * motion storm must not be able to exhaust memory, and a dead edge box must not
 * be hammered. Each check corresponds to a line in FANOUT.md "Definition of done".
 */
async function fanoutDeliveryChecks() {
  console.log('\nFan-out delivery');
  const { TargetDeliverer, FanoutDispatcher, __testing } = await import('../server/fanout/delivery.js');
  const settle = (ms = 60) => delay(ms);

  check('a 5xx is retryable', __testing.isRetryable(503));
  check('a 4xx is not retried', !__testing.isRetryable(400), 'a rejected payload will never succeed on retry');
  check('429 and 408 are retried', __testing.isRetryable(429) && __testing.isRetryable(408));

  // Queue overflow drops the OLDEST and counts it: bounded memory, visible loss.
  const overflow = new TargetDeliverer({ id: 'q', url: 'http://x', delivery: { queueSize: 3, concurrency: 0 } },
    { send: async () => ({ ok: true, status: 200 }) });
  for (let i = 0; i < 10; i += 1) overflow.enqueue({ id: `e${i}` });
  check('queue is bounded under a storm', overflow.stats().queued === 3, `queued ${overflow.stats().queued}`);
  check('overflow drops are counted, never silent', overflow.stats().droppedQueueFull === 7);
  check('the newest events are the ones kept', overflow.queue.at(-1).id === 'e9');

  // A dead target must stop being contacted rather than being hammered.
  let attempts = 0;
  const dead = new TargetDeliverer(
    { id: 'dead', url: 'http://dead', delivery: { maxAttempts: 1, breakerThreshold: 3, breakerCooldownMs: 60000, baseBackoffMs: 1 } },
    { send: async () => { attempts += 1; throw new Error('ECONNREFUSED'); } });
  for (let i = 0; i < 3; i += 1) { dead.enqueue({ id: `f${i}` }); await settle(25); }
  check('repeated failures trip the circuit breaker', dead.stats().breakerOpen === true);
  const before = attempts;
  for (let i = 0; i < 50; i += 1) dead.enqueue({ id: `storm${i}` });
  await settle();
  check('an open breaker sends nothing at all', attempts === before, `${attempts - before} requests leaked through`);
  check('events dropped by the breaker are counted', dead.stats().droppedBreakerOpen >= 50);
  check('the receiver error text is surfaced for diagnosis', /ECONNREFUSED/.test(dead.stats().lastError ?? ''));

  // A hung receiver must not pin a delivery slot forever.
  const hung = new TargetDeliverer(
    { id: 'hung', url: 'http://hung', delivery: { maxAttempts: 1, timeoutMs: 100, concurrency: 2, baseBackoffMs: 1 } },
    { send: (_t, _p, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  for (let i = 0; i < 6; i += 1) hung.enqueue({ id: `h${i}` });
  check('concurrency is capped', hung.inFlight === 2, `inFlight ${hung.inFlight}`);
  await settle(600);
  check('a hung receiver times out instead of blocking', hung.stats().failed === 6 && hung.stats().queued === 0);

  // One broken target must not affect the others, and must never throw into
  // the ONVIF event listener.
  const delivered = [];
  const dispatcher = new FanoutDispatcher({ send: async (t) => { delivered.push(t.id); return { ok: true, status: 200 }; } });
  dispatcher.setTargets([
    { id: 'good', url: 'http://a', enabled: true },
    { id: 'bad', url: 'http://b', enabled: true },
    { id: 'off', url: 'http://c', enabled: false },
  ]);
  let threw = false;
  try {
    dispatcher.dispatch({ topic: 'x' }, (target) => {
      if (target.id === 'bad') throw new Error('payload boom');
      return { id: 'e1', headers: {}, body: '{}' };
    });
  } catch { threw = true; }
  await settle();
  check('a failing target never throws into the event listener', threw === false);
  check('a failing target does not stop the others', delivered.includes('good') && !delivered.includes('bad'));
  check('a disabled target receives nothing', !delivered.includes('off'));

  // Reloading config must not silently reset breaker state and counters.
  dispatcher.deliverers.get('good').counters.delivered = 7;
  dispatcher.setTargets([{ id: 'good', url: 'http://a', enabled: true, delivery: { concurrency: 8 } }]);
  check('a config reload preserves delivery state', dispatcher.deliverers.get('good').counters.delivered === 7);
  check('a removed target is torn down', dispatcher.deliverers.size === 1);
  dispatcher.close();

  await fanoutEndToEndChecks();
}

/**
 * The full path against a real HTTP receiver: an ONVIF event goes in, a signed
 * webhook comes out, and the receiver independently verifies the HMAC. A unit
 * test cannot catch a signature computed over different bytes than were sent.
 */
async function fanoutEndToEndChecks() {
  const http = await import('node:http');
  const { createHmac } = await import('node:crypto');
  const { EventEmitter } = await import('node:events');
  const { attachFanout } = await import('../server/fanout/index.js');
  const { validateTargetUrl } = await import('../server/fanout/payload.js');

  const SECRET = 'edge-secret-1234';
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const expected = `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
      received.push({
        path: req.url,
        sigValid: req.headers['x-onvif-signature'] === expected,
        idMatches: req.headers['x-onvif-event-id'] === JSON.parse(body).id,
        payload: JSON.parse(body),
      });
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Shaped like the real 192.168.12.129: a 32-channel recorder.
  const session = {
    id: 'smoke-fanout',
    host: '192.168.12.129',
    port: 80,
    device: { manufacturer: 'UNIX', model: 'IPM32R32P', serial: '00:09:1B:2F:16:2F' },
    sources: [
      { token: 'Media1', label: 'Channel 1', profiles: [{ token: 'P1' }] },
      { token: 'Media7', label: 'Channel 7', profiles: [{ token: 'P13' }] },
    ],
    events: new EventEmitter(),
  };

  const detach = attachFanout(session, [
    { id: 'all', url: `http://127.0.0.1:${port}/all`, enabled: true, secret: SECRET },
    { id: 'motion', url: `http://127.0.0.1:${port}/motion`, enabled: true, secret: SECRET, filters: ['motion'] },
    { id: 'human', url: `http://127.0.0.1:${port}/human`, enabled: true, secret: SECRET, filters: ['human'] },
  ]);

  session.events.emit('event', {
    topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
    state: true,
    utcTime: '2026-08-25T15:22:01.000Z',
    data: { IsMotion: true },
    profileToken: 'P13',
  });
  await delay(400);
  detach();

  check('a signed webhook is delivered end to end', received.length > 0);
  check('the receiver can verify every HMAC signature', received.length > 0 && received.every((r) => r.sigValid));
  check('the event id header matches the signed body', received.every((r) => r.idMatches));
  check('a class filter routes only matching events',
    received.some((r) => r.path === '/motion') && !received.some((r) => r.path === '/human'),
    received.map((r) => r.path).join(','));

  const payload = received[0]?.payload;
  check('the event carries the resolved channel, not channel 1', payload?.source?.channel === 'Media7', payload?.source?.channel);
  check('the original vendor topic survives normalization',
    payload?.topic === 'tns1:RuleEngine/CellMotionDetector/Motion' && payload?.class === 'motion');
  check('device identity travels with the event', payload?.device?.model === 'IPM32R32P');
  check('no snapshot is attached by default', payload?.snapshot === null);
  check('no secret appears in the delivered payload', !JSON.stringify(received).includes(SECRET));

  // Regressions found against a live UNIX IPM32R32P NVR. A pull-point event
  // carries no profile token — it names its channel in its own Source item —
  // and its State arrives as a real boolean that must not be coerced to 0.
  const { buildPayload } = await import('../server/fanout/payload.js');
  const pullEvent = {
    topic: 'tns1:VideoSource/MotionAlarm',
    state: true,
    utcTime: '2026-08-25T16:45:46.000Z',
    source: { Source: 'Media7' },
    data: { State: true },
  };
  const pullPayload = buildPayload(session, pullEvent, { profileToken: null });
  check('a pull-point event resolves its channel from the event Source',
    pullPayload.source.channel === 'Media7', pullPayload.source.channel);
  check('a resolved pull-point channel carries its label',
    pullPayload.source.label === 'Channel 7', pullPayload.source.label);

  // An unrecognized channel is reported as the device stated it, never remapped.
  const unknownChannel = buildPayload(session, { ...pullEvent, source: { Source: 'Media99' } }, { profileToken: null });
  check('an unknown channel is reported verbatim, not remapped',
    unknownChannel.source.channel === 'Media99' && unknownChannel.source.label === null);

  // A boolean State must survive normalization.
  const { __testing: eventsTesting } = await import('../server/onvif/events.js')
    .then((m) => ({ __testing: m.__testing ?? null }));
  if (eventsTesting?.readItems) {
    const items = eventsTesting.readItems({ simpleItem: { $: { Name: 'State', Value: false } } });
    check('a boolean State is not coerced to a number', items.State === false, JSON.stringify(items));
  }

  // SSRF: the denylist applies, and RFC1918 stays usable.
  let blocked = false;
  try { validateTargetUrl('http://169.254.169.254/latest/meta-data'); } catch { blocked = true; }
  check('a cloud metadata webhook target is refused', blocked);
  let lanAllowed = true;
  try { validateTargetUrl('http://192.168.1.50:9000/hooks'); } catch { lanAllowed = false; }
  check('a private LAN webhook target is allowed', lanAllowed);

  await new Promise((resolve) => server.close(resolve));
}

/**
 * The always-visible-panel contract (UI-AVAILABILITY.md). These are source-level
 * assertions rather than DOM tests — there is no browser here — but they pin the
 * rules that are easy to regress: a disabled control creeping back in, a panel
 * quietly disappearing again, or a secret reaching the browser.
 */
async function uiAvailabilityChecks() {
  console.log('\nUI availability');
  const { readFile } = await import('node:fs/promises');
  const controller = await readFile(new URL('../public/js/views/controller.js', import.meta.url), 'utf8');

  check('no panel is skipped for being unsupported',
    !/if \(!def\.available\(\)\) continue;/.test(controller));
  check('an unsupported panel renders a reason instead of controls',
    /unavailable \? renderUnavailable\(content, unavailable\) : def\.build\(content\)/.test(controller));
  check('an unsupported panel never runs its build()',
    !/def\.build\(content\)[\s\S]{0,40}unavailable/.test(controller));
  check('an unavailable section is tagged for readers who cannot see colour',
    /sidebar-section-tag['"`,\s]*,?\s*'Unavailable'/.test(controller));

  // The reason text is the whole point: it must describe what was observed.
  for (const service of ['PTZ', 'Imaging', 'Events']) {
    check(`the ${service} panel explains why it is unavailable`,
      new RegExp(`ONVIF ${service} service`).test(controller), 'no observed-fact reason found');
  }
  check('a channel-scoped reason says other channels may differ',
    /Other channels on this (?:recorder|device) may still/.test(controller));

  // We already shipped and fixed a bug that blamed a vendor we had not
  // observed. Check the reason strings themselves — a comment may legitimately
  // mention a vendor while documenting exactly that mistake.
  const reasonText = [...controller.matchAll(/reason(?:OnChannel)?:[^,]*?'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1]).join('\n');
  check('a reason is stated for the unavailable panels', reasonText.length > 100, `${reasonText.length} chars`);
  check('no operator-facing reason names a vendor we did not observe',
    !/(hikvision|dahua|axis)/i.test(reasonText));
  check('no reason is a bare "Not supported"',
    !/^\s*not supported\.?\s*$/im.test(reasonText));

  const styles = await readFile(new URL('../public/styles/app.css', import.meta.url), 'utf8');
  check('unavailable sections have a dimmed, tagged style',
    /\.sidebar-section-unavailable/.test(styles) && /\.sidebar-section-tag/.test(styles));

  // Both new panels must exist for every device, available or not.
  check('a Playback panel is always listed', /name: 'Playback'/.test(controller));
  check('a Fan-out panel is always listed', /name: 'Fan-out'/.test(controller));

  const fanoutView = await readFile(new URL('../public/js/views/fanout.js', import.meta.url), 'utf8').catch(() => '');
  if (fanoutView) {
    check('the fan-out panel never renders a secret value',
      !/\bt(?:arget)?\.secret\b/.test(fanoutView) && !/\.secret\s*\|\|/.test(fanoutView),
      'a code path referenced target.secret');
    check('the fan-out panel is read-only',
      !/api\.(?:create|delete|update)Fanout|method:\s*'DELETE'/.test(fanoutView));
  }

  const playbackView = await readFile(new URL('../public/js/views/playback.js', import.meta.url), 'utf8').catch(() => '');
  if (playbackView) {
    // Building a player against a mock is the mistake the probe exists to stop.
    check('the playback panel builds no player against unverified hardware',
      !/<video|createElement\('video'\)|requestAnimationFrame/.test(playbackView));
    check('the playback panel warns when channels cannot be mapped',
      /wrong camera/i.test(playbackView));
  }
}

/**
 * Empty-password authentication. Some recorders ship an admin account with a
 * blank password (observed on UNIX RST08 / IPM32R32P NVRs). The `onvif` library
 * drops the WS-Security token when the password is empty, so these devices read
 * as "unauthorized" — a false negative. These checks pin the fix on both sides.
 */
async function emptyPasswordAuthChecks() {
  console.log('\nEmpty-password auth');
  const { readFile } = await import('node:fs/promises');

  // Server side: the library prototype is patched to emit the token whenever a
  // username is present, even with an empty password.
  const onvif = (await import('onvif')).default;
  const proto = onvif.Cam.prototype;
  check('the empty-password auth patch is installed', onvif.Cam.__emptyPasswordAuthPatched === true);

  const cam = Object.create(proto);
  Object.assign(cam, {
    username: 'admin', password: '', timeout: 1000, timeShift: 0,
  });
  const header = cam._envelopeHeader();
  check('an empty password still sends a WS-Security token',
    /<Security\b/.test(header) && /<Username>admin<\/Username>/.test(header) && /PasswordDigest/.test(header));

  // A truly anonymous request (no username) still sends no auth header.
  const anon = Object.create(proto);
  Object.assign(anon, { username: '', password: '', timeout: 1000, timeShift: 0 });
  check('an anonymous request sends no auth header', !/<Security\b/.test(anon._envelopeHeader()));

  // A normal username+password request is untouched by the patch.
  const normal = Object.create(proto);
  Object.assign(normal, { username: 'admin', password: 's3cret', timeout: 1000, timeShift: 0 });
  check('a normal password request still authenticates', /<Security\b/.test(normal._envelopeHeader()));

  // Frontend: the password field is valid when empty ONLY with the opt-in.
  const connectJs = await readFile(new URL('../public/js/views/connect.js', import.meta.url), 'utf8');
  check('the connect form has a no-password opt-in', /No password/.test(connectJs));
  check('an empty password is rejected without the opt-in',
    /allowEmpty[\s\S]{0,120}return 'Enter the ONVIF password/.test(connectJs)
    || /!password && !allowEmpty/.test(connectJs));
  check('the opt-in submits an explicit empty string, not undefined',
    /noPassword \? '' :/.test(connectJs));
}

/**
 * Container packaging. These are static file checks, not a live build — they run
 * without a Docker daemon so the security-critical mistakes are caught in CI and
 * on any developer machine.
 *
 * The one that matters most is the publish address: this app has no
 * authentication, so `ports: ["8080:8080"]` would hand camera reboot and network
 * config to the whole LAN. That must never regress silently.
 */
async function containerPackagingChecks() {
  console.log('\nContainer packaging');
  const { readFile } = await import('node:fs/promises');
  const read = async (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').catch(() => null);

  const compose = await read('compose.yaml') ?? await read('docker-compose.yml');
  if (compose) {
    // Every published port must be bound to loopback.
    const published = [...compose.matchAll(/^\s*-\s*["']?([0-9.:]+:)?(\d+):(\d+)["']?\s*$/gm)];
    const wide = published.filter((m) => !m[1] || !/^(127\.0\.0\.1|localhost):$/.test(m[1]));
    check('every published port is bound to loopback', wide.length === 0,
      wide.map((m) => m[0].trim()).join(', ') || '');
    check('the compose file explains why the publish address matters',
      /no authentication|security boundary|camera control/i.test(compose));
    check('the container binds 0.0.0.0 internally', /HOST[=:]\s*["']?0\.0\.0\.0/.test(compose),
      'without this the app is unreachable inside a container');
    check('signals reach the app so ffmpeg children are reaped',
      /init:\s*true/.test(compose) || /--init/.test(compose));
    check('no secret is inlined in the compose file',
      !/(secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._@$-]{6,}/i.test(compose));
  } else {
    check('a compose file exists', false, 'no compose.yaml found');
  }

  const dockerfile = await read('Dockerfile');
  if (dockerfile) {
    check('the image installs ffmpeg', /ffmpeg/i.test(dockerfile),
      'ffmpeg is the main reason this image exists');
    check('the image runs as a non-root user', /^\s*USER\s+(?!root\b)\S+/mi.test(dockerfile));
    check('dependencies install reproducibly', /npm ci/.test(dockerfile));
    check('the image adds no build step', !/tsc|webpack|rollup|esbuild|vite/i.test(dockerfile));
    check('the image declares a healthcheck', /HEALTHCHECK/i.test(dockerfile));
  } else {
    check('a Dockerfile exists', false, 'no Dockerfile found');
  }

  const ignore = await read('.dockerignore');
  if (ignore) {
    // A developer's local fanout.json carries an HMAC secret; baking it into a
    // layer would ship that secret with the image.
    for (const pattern of ['node_modules', '.git']) {
      check(`.dockerignore excludes ${pattern}`, new RegExp(`^\\s*${pattern.replace('.', '\\.')}`, 'm').test(ignore));
    }
    check('.dockerignore excludes local webhook config',
      /fanout|\*\.env|^\s*\.env/mi.test(ignore), 'a local fanout.json can carry an HMAC secret');
  } else {
    check('a .dockerignore exists', false, 'no .dockerignore found');
  }

  const entry = await read('docker/entrypoint.sh');
  if (entry) {
    check('the entrypoint execs the app so it receives SIGTERM', /\bexec\b/.test(entry),
      'without exec, docker stop leaks ffmpeg children');
    check('the entrypoint verifies ffmpeg is present', /ffmpeg/.test(entry));
  }
}

/**
 * PTZ safety. Both of these are physical-risk bugs: a camera that keeps moving
 * after Stop can run to a hard limit with nobody watching.
 */
async function ptzSafetyChecks() {
  console.log('\nPTZ safety (stop invalidation and per-channel teardown)');
  const ptz = await import('../server/onvif/ptz.js');

  // A move already on the wire must not restart the camera when it lands.
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const session = {
    ptz: { nodeToken: 'n' }, inflight: new Map(), ctx: {}, profiles: [{ token: 'P1' }],
    cam: {
      continuousMove: (o, cb) => { calls.push(`move:${o.profileToken}`); gate.then(() => cb(null, {})); },
      stop: (o, cb) => { calls.push(`stop:${o.profileToken}`); cb(null, {}); },
    },
  };
  ptz.continuousMove(session, { profileToken: 'P7', pan: 0.5, tilt: 0, zoom: 0 });
  await delay(10);
  ptz.continuousMove(session, { profileToken: 'P7', pan: 0.8, tilt: 0, zoom: 0 });
  await delay(10);
  await ptz.stopMove(session, { profileToken: 'P7' });
  release();
  await delay(50);
  check('a queued move never runs after Stop',
    calls.lastIndexOf('stop:P7') > calls.lastIndexOf('move:P7'), calls.join(' -> '));

  // Teardown must stop the channel that was actually moving.
  const stops = [];
  const nvr = {
    ptz: {}, inflight: new Map(), ctx: {}, profiles: [{ token: 'P1' }, { token: 'P7' }],
    cam: { continuousMove: (_o, cb) => cb(null, {}), stop: (o, cb) => { stops.push(o.profileToken); cb(null, {}); } },
  };
  await ptz.continuousMove(nvr, { profileToken: 'P7', pan: 0.5, tilt: 0, zoom: 0 });
  check('the moving channel is tracked, not assumed to be the first',
    ptz.movingProfiles(nvr).includes('P7'), JSON.stringify(ptz.movingProfiles(nvr)));
  stops.length = 0;
  for (const token of ptz.movingProfiles(nvr)) await ptz.stopMove(nvr, { profileToken: token });
  check('teardown stops the channel that was moving', stops.includes('P7'), stops.join(',') || 'none');
  check('teardown does not stop an idle channel', !stops.includes('P1'), stops.join(','));

  // Watchdogs are per channel: arming one must not disarm another's guard.
  const multi = {
    ptz: {}, inflight: new Map(), ctx: {}, profiles: [{ token: 'A' }, { token: 'B' }],
    cam: { continuousMove: (_o, cb) => cb(null, {}), stop: (_o, cb) => cb(null, {}) },
  };
  await ptz.continuousMove(multi, { profileToken: 'A', pan: 0.5, tilt: 0, zoom: 0 });
  await ptz.continuousMove(multi, { profileToken: 'B', pan: 0.5, tilt: 0, zoom: 0 });
  const armed = [...multi.inflight.values()].filter((v) => v.watchdog).length;
  check('each moving channel keeps its own dead-man watchdog', armed === 2, `armed=${armed}`);
}

async function main() {
  await profileDescriptionChecks();
  await playbackProbeChecks();
  await fanoutDeliveryChecks();
  await uiAvailabilityChecks();
  await emptyPasswordAuthChecks();
  await containerPackagingChecks();
  // Governor behavior lives in its own file: it is pure logic with no server or
  // device, so it runs before anything is booted.
  const { governorChecks } = await import('./governor-tests.mjs');
  await governorChecks(check);
  // Standing regressions for field bug classes that the single mock never
  // covered. See GOVERNOR.md "The eight bug classes".
  const { bugClassChecks } = await import('./bugclass-tests.mjs');
  await bugClassChecks(check);
  await ptzSafetyChecks();
  console.log('Starting mock camera and app server...');
  start('mock', ['tools/mock-camera.js', String(MOCK_PORT)]);
  start('app', ['server/index.js'], {
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    // Exercise the real pipeline against a synthetic source. See tools/fake-ffmpeg.mjs.
    FFMPEG_PATH: process.env.SMOKE_REAL_FFMPEG ? undefined : path.resolve('tools/fake-ffmpeg.mjs'),
  });

  if (!await waitForPort(`${BASE}/api/health`)) {
    console.error('Server did not come up. Run with VERBOSE=1 to see why.');
    process.exit(1);
  }

  console.log('\nHealth');
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('health reports ok', health.ok === true);
  check('health reports ffmpeg presence', typeof health.ffmpeg === 'boolean');

  console.log('\nConnect');
  const connectRes = await fetch(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: MOCK_PORT, username: 'admin', password: 'admin' }),
  });
  const session = await connectRes.json();
  check('connect returns 200', connectRes.status === 200, JSON.stringify(session).slice(0, 200));
  check('connect returns a sessionId', typeof session.sessionId === 'string');
  check('device info populated', Boolean(session.device?.manufacturer));
  check('capability matrix present', typeof session.capabilities?.media === 'boolean');
  check('at least one profile', Array.isArray(session.profiles) && session.profiles.length > 0);
  check('clock skew computed', session.device?.clockSkewSeconds !== undefined);
  check('no password echoed back', !JSON.stringify(session).includes('"password"'));
  check('no rtsp credentials leaked', !/rtsp:\/\/[^"]*:[^"]*@/.test(JSON.stringify(session)));

  const id = session.sessionId;
  const profile = session.profiles?.[0]?.token;

  console.log('\nSession rehydrate');
  const rehydrate = await fetch(`${BASE}/api/session/${id}`);
  const rehydrated = await rehydrate.json();
  check('rehydrate returns 200', rehydrate.status === 200);
  check('rehydrate omits sessionId', rehydrated.sessionId === undefined);
  check('rehydrate matches profiles', rehydrated.profiles?.length === session.profiles?.length);

  console.log('\nError envelope');
  const missing = await fetch(`${BASE}/api/session/does-not-exist`);
  const missingBody = await missing.json();
  check('unknown session is 404', missing.status === 404);
  check('error envelope has code', missingBody.error?.code === 'SESSION_EXPIRED');
  check('error envelope has message', typeof missingBody.error?.message === 'string');
  check('error envelope has hint field', 'hint' in (missingBody.error ?? {}));

  const badEndpoint = await fetch(`${BASE}/api/nope`);
  check('unknown api endpoint is 404', badEndpoint.status === 404);

  const badConnect = await fetch(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '169.254.169.254', port: 80, username: 'a', password: 'b' }),
  });
  const badConnectBody = await badConnect.json();
  check('cloud metadata host is blocked', badConnect.status === 400 && badConnectBody.error?.code === 'BAD_REQUEST');

  console.log('\nMedia');
  const profiles = await (await fetch(`${BASE}/api/session/${id}/profiles`)).json();
  check('profiles endpoint works', Array.isArray(profiles.profiles) && profiles.profiles.length > 0);

  if (session.capabilities?.ptz) {
    console.log('\nPTZ');
    const move = await fetch(`${BASE}/api/session/${id}/ptz/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pan: 0.5, tilt: -0.25, zoom: 0 }),
    });
    check('continuous move accepted', move.status === 204, `got ${move.status}`);

    const stop = await fetch(`${BASE}/api/session/${id}/ptz/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    check('stop accepted', stop.status === 204, `got ${stop.status}`);

    const presets = await fetch(`${BASE}/api/session/${id}/ptz/presets?profile=${profile}`);
    const presetBody = await presets.json();
    check('presets listed', presets.status === 200 && Array.isArray(presetBody.presets), JSON.stringify(presetBody).slice(0, 150));

    // A burst of moves must not queue up a backlog.
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${BASE}/api/session/${id}/ptz/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pan: i / 12, tilt: 0, zoom: 0 }),
    })));
    check('rapid move burst all accepted', burst.every((r) => r.status === 204));
  } else {
    console.log('\nPTZ (device reports none — checking the surface is absent, not broken)');
    const move = await fetch(`${BASE}/api/session/${id}/ptz/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pan: 0.5, tilt: 0, zoom: 0 }),
    });
    const body = await move.json();
    check('ptz move on non-ptz device is UNSUPPORTED', body.error?.code === 'UNSUPPORTED', JSON.stringify(body).slice(0, 150));
  }

  if (session.capabilities?.imaging) {
    console.log('\nImaging');
    const imaging = await fetch(`${BASE}/api/session/${id}/imaging?profile=${profile}`);
    const imagingBody = await imaging.json();
    check('imaging read works', imaging.status === 200, JSON.stringify(imagingBody).slice(0, 200));
    check('imaging returns settings', typeof imagingBody.settings === 'object');
    check('imaging returns options', typeof imagingBody.options === 'object');
    const hasRange = Object.values(imagingBody.options ?? {}).some((v) => v && typeof v === 'object' && 'min' in v);
    check('imaging options carry device ranges', hasRange, 'sliders must not hardcode 0-100');

    const write = await fetch(`${BASE}/api/session/${id}/imaging`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, settings: { brightness: 200 } }),
    });
    const writeBody = await write.json();
    check('default imaging write returns 200', write.status === 200, JSON.stringify(writeBody).slice(0, 200));
    check('default imaging write is confirmed applied', writeBody.applied?.brightness === true, JSON.stringify(writeBody));
    check('default imaging write is read back from camera', writeBody.settings?.brightness === 200, JSON.stringify(writeBody));
    const imagingCalls = await fetch(`http://127.0.0.1:${MOCK_PORT}/__calls`).then((r) => r.json());
    check('SetImagingSettings sends every previously reported field', imagingCalls.imagingFullBlock === true, JSON.stringify(imagingCalls));

    async function exerciseImagingMode(mode, port, requested, expected, expectedApplied) {
      start(`mock-${mode}`, ['tools/mock-camera.js', String(port)], { MOCK_IMAGING_MODE: mode });
      await delay(500);
      const connected = await fetch(`${BASE}/api/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port, username: 'admin', password: 'admin' }),
      });
      const connectedBody = await connected.json();
      check(`${mode} camera connects`, connected.status === 200, JSON.stringify(connectedBody).slice(0, 160));
      const modeProfile = connectedBody.profiles?.[0]?.token;
      const result = await fetch(`${BASE}/api/session/${connectedBody.sessionId}/imaging`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: modeProfile, settings: { brightness: requested } }),
      });
      const resultBody = await result.json();
      check(`${mode} write returns 200`, result.status === 200, JSON.stringify(resultBody).slice(0, 180));
      check(`${mode} write reports applied=${expectedApplied}`, resultBody.applied?.brightness === expectedApplied, JSON.stringify(resultBody));
      check(`${mode} write reports device value ${expected}`, resultBody.settings?.brightness === expected, JSON.stringify(resultBody));
      const received = await fetch(`http://127.0.0.1:${port}/__calls`).then((r) => r.json());
      check(`${mode} write sends a full settings block`, received.imagingFullBlock === true, JSON.stringify(received));
    }

    await exerciseImagingMode('ignore', MOCK_PORT + 2, 100, 255, false);
    await exerciseImagingMode('clamp', MOCK_PORT + 3, 250, 200, true);
  }


  console.log('\nVideo encoder configuration');
  if (profile) {
    const encUrl = `${BASE}/api/session/${id}/encoder`;
    const encRead = await fetch(`${encUrl}?profile=${encodeURIComponent(profile)}`);
    const enc = await encRead.json();
    check('encoder read returns 200', encRead.status === 200, JSON.stringify(enc).slice(0, 200));
    check('encoder reports current resolution',
      Number.isFinite(enc.current?.width) && Number.isFinite(enc.current?.height),
      JSON.stringify(enc.current));
    check('encoder reports an encoding', typeof enc.current?.encoding === 'string', JSON.stringify(enc.current));

    const resList = enc.options?.resolutions?.[enc.current?.encoding]
      ?? Object.values(enc.options?.resolutions ?? {}).flat();
    check('encoder options carry a device resolution list',
      Array.isArray(resList) && resList.length > 0, JSON.stringify(enc.options?.resolutions).slice(0, 200));
    check('encoder options carry an fps range',
      Number.isFinite(enc.options?.fps?.min) && Number.isFinite(enc.options?.fps?.max),
      JSON.stringify(enc.options?.fps));

    // Per-profile option sets must differ. A UI that reuses one profile's list
    // for another will offer resolutions the device rejects.
    const profiles = session.profiles ?? [];
    if (profiles.length > 1) {
      const other = profiles.find((p) => p.token !== profile)?.token;
      const otherEnc = await (await fetch(`${encUrl}?profile=${encodeURIComponent(other)}`)).json();
      const otherList = Object.values(otherEnc.options?.resolutions ?? {}).flat();
      const firstSet = new Set(resList.map((r) => `${r.width}x${r.height}`));
      const secondSet = new Set(otherList.map((r) => `${r.width}x${r.height}`));
      const disjoint = [...secondSet].every((r) => !firstSet.has(r));
      check('each profile reports its OWN resolution set', disjoint,
        `main=${[...firstSet].join(',')} sub=${[...secondSet].join(',')}`);
    }

    // A resolution the device never advertised must be refused locally.
    const bogus = await fetch(encUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, settings: { width: 12345, height: 6789 } }),
    });
    const bogusBody = await bogus.json();
    check('an unsupported resolution is rejected',
      bogus.status === 400 && bogusBody.error?.code === 'BAD_REQUEST',
      JSON.stringify(bogusBody).slice(0, 200));
    check('the rejection names what is allowed',
      /\d+x\d+/.test(`${bogusBody.error?.message} ${bogusBody.error?.hint}`),
      JSON.stringify(bogusBody.error));

    // A supported resolution applies and reads back.
    const target = resList.find((r) => r.width !== enc.current.width) ?? resList[0];
    const patch = await fetch(encUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, settings: { width: target.width, height: target.height } }),
    });
    const patched = await patch.json();
    check('a supported resolution change returns 200', patch.status === 200, JSON.stringify(patched).slice(0, 200));
    check('the resolution change is reported applied',
      patched.applied?.width === true && patched.applied?.height === true, JSON.stringify(patched.applied));
    check('the device reports the new resolution',
      patched.current?.width === target.width && patched.current?.height === target.height,
      `${patched.current?.width}x${patched.current?.height} wanted ${target.width}x${target.height}`);
    check('streamRestartRequired is present', typeof patched.streamRestartRequired === 'boolean',
      JSON.stringify(patched.streamRestartRequired));

    // Restore, so later checks see the original geometry.
    await fetch(encUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, settings: { width: enc.current.width, height: enc.current.height } }),
    });
  }

  console.log('\nDevice');
  const device = await fetch(`${BASE}/api/session/${id}/device`);
  const deviceBody = await device.json();
  check('device read works', device.status === 200, JSON.stringify(deviceBody).slice(0, 200));
  check('device info present', Boolean(deviceBody.info));
  check('device time block present', Boolean(deviceBody.time));
  check('relay outputs is an array', Array.isArray(deviceBody.relayOutputs));

  console.log('\nNetwork configuration');
  const networkUrl = `${BASE}/api/session/${id}/device/network`;
  const networkRead = await fetch(networkUrl);
  const networkBody = await networkRead.json();
  check('network read returns 200', networkRead.status === 200, JSON.stringify(networkBody).slice(0, 200));
  check('network read returns hostname', typeof networkBody.hostname === 'string', JSON.stringify(networkBody));
  check('network read returns interfaces', Array.isArray(networkBody.interfaces) && networkBody.interfaces.length > 0, JSON.stringify(networkBody));
  check('network read returns DNS and NTP lists', Array.isArray(networkBody.dns) && Array.isArray(networkBody.ntp));

  const hostnameWrite = await fetch(networkUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { hostname: 'camera-loading-dock' } }),
  });
  const hostnameBody = await hostnameWrite.json();
  check('hostname write returns 200', hostnameWrite.status === 200, JSON.stringify(hostnameBody));
  check('hostname write is verified applied', hostnameBody.applied?.hostname === true, JSON.stringify(hostnameBody));
  check('hostname response contains read-back value', hostnameBody.hostname === 'camera-loading-dock', JSON.stringify(hostnameBody));

  const dnsWrite = await fetch(networkUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { dns: ['1.1.1.1', '9.9.9.9'] } }),
  });
  const dnsBody = await dnsWrite.json();
  check('DNS write returns 200', dnsWrite.status === 200, JSON.stringify(dnsBody));
  check('DNS write is verified applied', dnsBody.applied?.dns === true, JSON.stringify(dnsBody));
  check('DNS response contains read-back list', JSON.stringify(dnsBody.dns) === JSON.stringify(['1.1.1.1', '9.9.9.9']), JSON.stringify(dnsBody));

  for (const [label, settings] of [
    ['malformed IPv4', { ipv4: '999.4.3.2' }],
    ['out-of-range prefix', { prefix: 33 }],
  ]) {
    const invalid = await fetch(networkUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const invalidBody = await invalid.json();
    check(`${label} is rejected with BAD_REQUEST`, invalid.status === 400 && invalidBody.error?.code === 'BAD_REQUEST', JSON.stringify(invalidBody));
  }

  const ignorePort = MOCK_PORT + 4;
  start('mock-network-ignore', ['tools/mock-camera.js', String(ignorePort)], { MOCK_NETWORK_MODE: 'ignore' });
  await delay(500);
  const ignoredConnect = await fetch(`${BASE}/api/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: ignorePort, username: 'admin', password: 'admin' }),
  });
  const ignoredSession = await ignoredConnect.json();
  check('ignore-mode network camera connects', ignoredConnect.status === 200, JSON.stringify(ignoredSession).slice(0, 180));
  const ignoredWrite = await fetch(`${BASE}/api/session/${ignoredSession.sessionId}/device/network`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { hostname: 'camera-ignored-write' } }),
  });
  const ignoredBody = await ignoredWrite.json();
  check('ignored network write still returns camera response', ignoredWrite.status === 200, JSON.stringify(ignoredBody));
  check('ignored network write reports applied false', ignoredBody.applied?.hostname === false, JSON.stringify(ignoredBody));
  check('ignored network write preserves reported value', ignoredBody.hostname !== 'camera-ignored-write', JSON.stringify(ignoredBody));

  const relocation = await fetch(networkUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { dhcp: false, ipv4: '192.168.100.50', prefix: 24 } }),
  });
  const relocationBody = await relocation.json();
  check('address-affecting write returns 200', relocation.status === 200, JSON.stringify(relocationBody));
  check('address-affecting write is flagged as relocation', relocationBody.relocation?.expected === true, JSON.stringify(relocationBody));
  check('relocation response includes expected address', relocationBody.relocation?.address === '192.168.100.50', JSON.stringify(relocationBody));



  console.log('\nPTZ safety (server-side dead-man watchdog)');
  // The browser is not a trustworthy place for the only stop signal: a closed
  // tab, a slept laptop or a dropped network all leave a continuous move
  // running. The server must stop the camera on its own.
  const calls = () => fetch(`http://127.0.0.1:${MOCK_PORT}/__calls`).then((r) => r.json());
  const resetCalls = () => fetch(`http://127.0.0.1:${MOCK_PORT}/__reset`, { method: 'POST' });

  if (session.capabilities?.ptz) {
    await resetCalls();
    await fetch(`${BASE}/api/session/${id}/ptz/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pan: 0.6, tilt: 0, zoom: 0 }),
    });
    const afterMove = await calls();
    check('continuous move reaches the camera', (afterMove.ContinuousMove ?? 0) >= 1, JSON.stringify(afterMove));
    check('no stop issued while the move is fresh', (afterMove.Stop ?? 0) === 0, JSON.stringify(afterMove));

    // Go quiet, as a dead client would, and let the watchdog fire.
    await delay(2200);
    const afterSilence = await calls();
    check('watchdog stops the camera when the client goes silent',
      (afterSilence.Stop ?? 0) >= 1, JSON.stringify(afterSilence));

    // A keepalive stream must NOT trip the watchdog.
    await resetCalls();
    for (let i = 0; i < 8; i++) {
      await fetch(`${BASE}/api/session/${id}/ptz/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, pan: 0.4, tilt: 0, zoom: 0 }),
      });
      await delay(150);
    }
    const duringHold = await calls();
    check('a held joystick is not interrupted by the watchdog',
      (duringHold.Stop ?? 0) === 0, JSON.stringify(duringHold));
    await fetch(`${BASE}/api/session/${id}/ptz/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }),
    });
  }

  console.log('\nWebSockets');
  // The REST surface passing tells you nothing about the sockets: both were
  // green here while every /ws/events connection was dying on a TDZ error.
  const wsBase = `ws://127.0.0.1:${APP_PORT}`;

  async function openSocket(url, { origin, waitMs = 3000 } = {}) {
    return new Promise((resolve) => {
      const frames = [];
      let ws;
      try {
        // The `ws` client, not the global WebSocket: only this one can set a
        // custom Origin header, which the cross-origin check below depends on.
        ws = new WsClient(url, origin ? { headers: { Origin: origin } } : undefined);
      } catch (err) {
        resolve({ error: String(err), frames, closeCode: null });
        return;
      }
      const done = (closeCode) => resolve({ frames, closeCode, error: null });
      const timer = setTimeout(() => { try { ws.close(); } catch {} done(null); }, waitMs);
      ws.on('message', (data, isBinary) => {
        if (isBinary) frames.push({ binary: true });
        else { try { frames.push(JSON.parse(String(data))); } catch { frames.push({ raw: true }); } }
      });
      ws.on('close', (code) => { clearTimeout(timer); done(code); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ frames, closeCode: null, error: `HTTP ${res.statusCode}` }); });
      ws.on('error', () => {});
    });
  }

  const eventsSock = await openSocket(`${wsBase}/ws/events?session=${id}`, { waitMs: 2500 });
  const eventTypes = eventsSock.frames.map((f) => f.type);
  check('events socket stays open', eventsSock.closeCode === null || eventsSock.closeCode === 1000,
    `closed with ${eventsSock.closeCode}`);
  check('events socket does not error out', !eventTypes.includes('error'),
    JSON.stringify(eventsSock.frames.slice(0, 2)));

  const badStream = await openSocket(`${wsBase}/ws/stream?session=${id}&stream=nope`, { waitMs: 1500 });
  check('stream socket rejects an unknown stream', badStream.closeCode === 4002,
    `closed with ${badStream.closeCode}`);

  const badSession = await openSocket(`${wsBase}/ws/events?session=00000000-0000-0000-0000-000000000000`, { waitMs: 1500 });
  check('events socket rejects an unknown session', badSession.closeCode === 4001,
    `closed with ${badSession.closeCode}`);

  const crossOrigin = await openSocket(`${wsBase}/ws/events?session=${id}`, { origin: 'http://evil.example', waitMs: 1500 });
  check('cross-origin upgrade is refused', crossOrigin.closeCode !== null || crossOrigin.error !== null,
    'a hostile page must not be able to open a control socket');

  const crossOriginApi = await fetch(`${BASE}/api/session/${id}`, { headers: { Origin: 'http://evil.example' } });
  check('cross-origin API request is refused', crossOriginApi.status === 400, `got ${crossOriginApi.status}`);


  console.log('\nLive stream pipeline (synthetic source via the ffmpeg shim)');
  let streamId = null;
  {
    const startRes = await fetch(`${BASE}/api/session/${id}/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    const info = await startRes.json();
    check('stream/start returns 200', startRes.status === 200, JSON.stringify(info).slice(0, 250));
    check('stream/start returns a streamId', typeof info.streamId === 'string', JSON.stringify(info).slice(0, 150));
    check('stream/start returns an MSE mime type', /^video\/mp4; codecs=/.test(info.mime ?? ''), String(info.mime));
    check('mime carries a real avc1 codec string', /avc1\.[0-9a-fA-F]{6}/.test(info.mime ?? ''), String(info.mime));
    streamId = info.streamId;

    if (streamId) {
      const sock = await openSocket(`${wsBase}/ws/stream?session=${id}&stream=${streamId}`, { waitMs: 4000 });
      const text = sock.frames.filter((f) => !f.binary);
      const binary = sock.frames.filter((f) => f.binary);
      check('stream socket sends a ready frame first',
        text[0]?.type === 'ready', JSON.stringify(text.slice(0, 2)));
      check('stream socket delivers an init segment', binary.length >= 1, `${binary.length} binary frames`);
      check('stream socket delivers media fragments', binary.length >= 3,
        `only ${binary.length} binary frames — the box parser may not be emitting moof/mdat pairs`);
      check('stream socket reports no error', !text.some((f) => f.type === 'error'),
        JSON.stringify(text.filter((f) => f.type === 'error').slice(0, 1)));

      const stopRes = await fetch(`${BASE}/api/session/${id}/stream/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId }),
      });
      check('stream/stop returns 204', stopRes.status === 204, `got ${stopRes.status}`);
      await delay(1200);
      let alive = '';
      try {
        const { execSync } = await import('node:child_process');
        // Match only this run's shim, never an unrelated ffmpeg the operator
        // has streaming from a real camera on the same machine.
        alive = execSync('pgrep -fl "fake-ffmpeg" || true', { encoding: 'utf8' }).trim();
      } catch { /* nothing matched */ }
      check('stopping the stream kills its ffmpeg', alive === '', alive.slice(0, 200));
    }
  }


  console.log('\nCrash resistance (onvif library throws from its own event loop)');
  {
    // The library calls unsubscribe({}, cb) from inside its PullMessages error
    // path. With no live subscription it throws SYNCHRONOUSLY from a callback,
    // which is uncatchable by any caller and killed the whole server mid-stream
    // on a real camera. Reproduce it, then prove the guard neutralizes it.
    const onvifMod = (await import('onvif')).default;
    const { guardUnsubscribe } = await import('../server/onvif/events.js');

    // Exercise the real Cam.prototype.unsubscribe against a bare object rather
    // than a live Cam: constructing a real one makes the library start its pull
    // loop and hit the network, which is not what this test is about.
    const cam = Object.create(onvifMod.Cam.prototype);
    cam.events = {};   // the crash precondition: subscription already gone

    let unguardedThrew = false;
    try { cam.unsubscribe({}, () => {}); } catch (err) {
      unguardedThrew = /pull-point subscription first/.test(String(err?.message));
    }
    check('the library really does throw here (guard is still needed)', unguardedThrew,
      'if this fails the upstream bug was fixed and the guard can be revisited');

    guardUnsubscribe(cam);

    let guardedThrew = false;
    let callbackRan = false;
    try { cam.unsubscribe({}, () => { callbackRan = true; }); } catch { guardedThrew = true; }
    check('guarded unsubscribe does not throw', !guardedThrew);
    check('guarded unsubscribe still invokes the callback', callbackRan,
      'the library loops on this callback; swallowing it would stall the event loop');

    let bareThrew = false;
    try { cam.unsubscribe(); } catch { bareThrew = true; }
    check('guarded unsubscribe handles the bare call shape too', !bareThrew);
  }


  console.log('\nVendor fallback end to end (ONVIF stub + working vendor API)');
  {
    // Neither branch could test this: it needs an ONVIF camera that accepts
    // imaging writes and ignores them, AND a vendor CGI on the same host that
    // actually works. That is exactly the operator's camera.
    const onvifPort = MOCK_PORT + 40;
    const vendorPort = MOCK_PORT + 41;
    const appPort = APP_PORT + 3;

    start('mock-onvif-stub', ['tools/mock-camera.js', String(onvifPort)], { MOCK_IMAGING_MODE: 'ignore' });
    start('mock-vendor-ok', ['tools/mock-vendor-camera.js', String(vendorPort)]);
    start('app-fallback', ['server/index.js'], {
      PORT: String(appPort), HOST: '127.0.0.1',
      VENDOR_HTTP_PORT: String(vendorPort),
      FFMPEG_PATH: path.resolve('tools/fake-ffmpeg.mjs'),
    });
    const fbBase = `http://127.0.0.1:${appPort}`;
    const up = await waitForPort(`${fbBase}/api/health`);
    check('fallback app started', up);

    if (up) {
      // The vendor mock only accepts password "admin", and the ONVIF mock
      // accepts anything, so one credential pair drives both.
      const conn = await fetch(`${fbBase}/api/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: onvifPort, username: 'admin', password: 'admin' }),
      });
      const sess = await conn.json();
      check('fallback session connects', typeof sess.sessionId === 'string', JSON.stringify(sess).slice(0, 160));

      if (sess.sessionId) {
        const prof = sess.profiles?.[0]?.token;
        const patch = await fetch(`${fbBase}/api/session/${sess.sessionId}/imaging`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: prof, settings: { brightness: 77 } }),
        });
        const body = await patch.json();
        check('imaging patch succeeds via fallback', patch.status === 200, JSON.stringify(body).slice(0, 200));
        check('result is attributed to the vendor driver', body.source === 'vatilon',
          `source=${body.source}`);
        check('vendor driver name is surfaced', typeof body.driver === 'string' && body.driver.length > 0,
          `driver=${body.driver}`);
        check('the value the ONVIF path refused is now applied',
          body.applied?.brightness === true, JSON.stringify(body.applied));
        check('the device reports the requested value', body.settings?.brightness === 77,
          `brightness=${body.settings?.brightness}`);

        // A camera whose ONVIF works must NOT be routed to a vendor driver.
        const okConn = await fetch(`${fbBase}/api/connect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: '127.0.0.1', port: MOCK_PORT, username: 'admin', password: 'admin' }),
        });
        const okSess = await okConn.json();
        if (okSess.sessionId) {
          const okPatch = await fetch(`${fbBase}/api/session/${okSess.sessionId}/imaging`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: okSess.profiles?.[0]?.token, settings: { brightness: 90 } }),
          });
          const okBody = await okPatch.json();
          check('a working ONVIF camera stays on the ONVIF path',
            okBody.source === 'onvif', `source=${okBody.source}`);
        }
      }
    }
  }


  console.log('\nEncoder change restarts the live stream');
  {
    // A resolution change invalidates the browser's SourceBuffer: ffmpeg keeps
    // producing fragments and the socket stays open, but the init segment no
    // longer describes the data, so the video freezes while every health signal
    // still says fine. The server must force a rebuild rather than let that
    // silent failure happen.
    const { restartStreamsForProfile, hasLiveStreamForProfile } =
      await import('../server/stream/pipeline.js');
    check('pipeline exposes a profile restart hook',
      typeof restartStreamsForProfile === 'function' && typeof hasLiveStreamForProfile === 'function');

    if (profile) {
      const startRes = await fetch(`${BASE}/api/session/${id}/stream/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const info = await startRes.json();
      if (info.streamId) {
        const sock = await openSocket(`${wsBase}/ws/stream?session=${id}&stream=${info.streamId}`, { waitMs: 2500 });
        check('stream is live before the encoder change',
          sock.frames.some((f) => f.binary), `${sock.frames.length} frames`);

        // Change the encoder while that stream is running.
        const encRead = await (await fetch(`${BASE}/api/session/${id}/encoder?profile=${encodeURIComponent(profile)}`)).json();
        const list = Object.values(encRead.options?.resolutions ?? {}).flat();
        const target = list.find((r) => r.width !== encRead.current?.width);
        if (target) {
          const patched = await (await fetch(`${BASE}/api/session/${id}/encoder`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile, settings: { width: target.width, height: target.height } }),
          })).json();
          check('a change to a streaming profile flags a restart',
            patched.streamRestartRequired === true, JSON.stringify(patched.streamRestartRequired));

          await delay(800);
          const stillLive = hasLiveStreamForProfile(id, profile);
          check('the stale pipeline is gone after the encoder change', stillLive === false,
            'a surviving pipeline would feed fragments the browser silently rejects');

          // Restore.
          await fetch(`${BASE}/api/session/${id}/encoder`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile, settings: { width: encRead.current.width, height: encRead.current.height } }),
          });
        }
        await fetch(`${BASE}/api/session/${id}/stream/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId: info.streamId }),
        });
      }
    }
  }


  console.log('\nMulti-channel recorder (DVR/NVR)');
  {
    // The bug this feature exists to prevent: on a recorder, a per-channel
    // setting that cannot resolve its channel silently lands on channel 1, the
    // write genuinely succeeds, and read-back confirms it. The operator is told
    // it worked. Prove that no longer happens.
    const dvrPort = MOCK_PORT + 50;
    start('mock-dvr', ['tools/mock-camera.js', String(dvrPort)], { MOCK_CHANNELS: '8' });
    await delay(1500);

    const conn = await fetch(`${BASE}/api/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: dvrPort, username: 'admin', password: 'admin' }),
    });
    const dvr = await conn.json();
    check('recorder connects', typeof dvr.sessionId === 'string', JSON.stringify(dvr).slice(0, 180));

    const progressConnect = await fetch(`${BASE}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ host: '127.0.0.1', port: dvrPort, username: 'admin', password: 'admin' }),
    });
    const connectEvents = await readNdjson(progressConnect);
    const profileEvents = connectEvents.filter((event) => event.type === 'progress' && event.phase === 'profiles');
    check('connect progress response uses NDJSON',
      /^application\/x-ndjson\b/.test(progressConnect.headers.get('content-type') ?? ''));
    check('connect profile progress is monotonic',
      profileEvents.length > 1
        && profileEvents.every((event, index) => index === 0 || event.completed >= profileEvents[index - 1].completed));
    check('connect profile progress terminates',
      profileEvents.at(-1)?.completed === 16 && profileEvents.at(-1)?.total === 16);
    const completedConnect = connectEvents.find((event) => event.type === 'complete')?.session;
    check('progress connect returns the same sources and profiles as JSON connect',
      JSON.stringify(completedConnect?.sources) === JSON.stringify(dvr.sources)
        && JSON.stringify(completedConnect?.profiles) === JSON.stringify(dvr.profiles));
    if (completedConnect?.sessionId) {
      await fetch(`${BASE}/api/session/${completedConnect.sessionId}/disconnect`, { method: 'POST' });
    }

    if (dvr.sessionId) {
      check('recorder is flagged multi-channel', dvr.isMultiChannel === true, `isMultiChannel=${dvr.isMultiChannel}`);
      check('every channel is enumerated as a source',
        Array.isArray(dvr.sources) && dvr.sources.length === 8, `sources=${dvr.sources?.length}`);
      check('each source carries its own profiles',
        dvr.sources?.every((s) => Array.isArray(s.profiles) && s.profiles.length >= 1),
        JSON.stringify(dvr.sources?.[0]).slice(0, 160));
      check('each source has a label', dvr.sources?.every((s) => typeof s.label === 'string' && s.label), 
        JSON.stringify(dvr.sources?.map((s) => s.label)).slice(0, 160));
      check('PTZ support is reported per source, not per device',
        new Set(dvr.sources?.map((s) => s.ptzSupported)).size > 1,
        'the mock gives some channels PTZ and not others: ' + JSON.stringify(dvr.sources?.map((s) => s.ptzSupported)));

      // Profiles must not be silently collapsed onto one channel.
      const tokens = new Set(dvr.sources?.flatMap((s) => s.profiles.map((p) => p.token)));
      check('no profile is shared between channels',
        tokens.size === dvr.sources.reduce((n, s) => n + s.profiles.length, 0),
        `${tokens.size} unique profile tokens`);

      const channel = dvr.sources?.[3];
      const otherChannel = dvr.sources?.[4];
      const channelProfile = channel?.profiles?.[0]?.token;
      if (channelProfile) {
        const scopedRes = await fetch(`${BASE}/api/session/${dvr.sessionId}/stream-urls?profile=${encodeURIComponent(channelProfile)}`);
        const scoped = await scopedRes.json();
        const scopedTokens = new Set(scoped.urls?.map((entry) => entry.token));
        check('stream URLs are scoped to the requested channel',
          channel.profiles.every((entry) => scopedTokens.has(entry.token)), JSON.stringify(scoped.urls));
        check('stream URLs exclude another channel',
          otherChannel.profiles.every((entry) => !scopedTokens.has(entry.token)), JSON.stringify(scoped.urls));
        check('stream URL count matches the channel profile count',
          scoped.urls?.length === channel.profiles.length && scoped.urls.length < dvr.profiles.length,
          `urls=${scoped.urls?.length} channel=${channel.profiles.length} device=${dvr.profiles.length}`);
        check('stream URL entries carry codec and resolution',
          scoped.urls?.every((entry) => entry.codec && entry.resolution), JSON.stringify(scoped.urls));
        check('stream URL credentials remain opt-in',
          scoped.credentialsIncluded === false
            && scoped.urls?.every((entry) => entry.rtspWithCredentials === null && !/@/.test(entry.rtsp ?? '')),
          JSON.stringify(scoped));

        const credentialed = await (await fetch(
          `${BASE}/api/session/${dvr.sessionId}/stream-urls?profile=${encodeURIComponent(channelProfile)}&credentials=true`,
        )).json();
        check('explicit credential request returns credentialed stream URLs',
          credentialed.credentialsIncluded === true
            && credentialed.urls?.every((entry) => !entry.rtsp || /@/.test(entry.rtspWithCredentials ?? '')),
          JSON.stringify(credentialed));
      }

      // THE CORE SAFETY CHECK: write to a late channel, assert channel 1 is untouched.
      const ch7 = dvr.sources?.[6];
      const ch7Profile = ch7?.profiles?.[0]?.token;
      if (ch7Profile) {
        const calls = () => fetch(`http://127.0.0.1:${dvrPort}/__calls`).then((r) => r.json());
        await fetch(`http://127.0.0.1:${dvrPort}/__reset`, { method: 'POST' });
        const wrote = await fetch(`${BASE}/api/session/${dvr.sessionId}/imaging`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: ch7Profile, settings: { brightness: 77 } }),
        });
        const wroteBody = await wrote.json();
        const after = await calls();
        check('a channel 7 imaging write reaches channel 7',
          (after['imaging.set.ch7'] ?? 0) >= 1, JSON.stringify(after));
        check('a channel 7 write does NOT touch channel 1',
          (after['imaging.set.ch1'] ?? 0) === 0,
          'this is the silent wrong-channel bug: ' + JSON.stringify(after));
        check('the channel 7 write reports the value it set',
          wroteBody.settings?.brightness === 77, JSON.stringify(wroteBody.settings).slice(0, 120));
      }

      // An omitted profile on a recorder must refuse, not default to channel 1.
      const guessed = await fetch(`${BASE}/api/session/${dvr.sessionId}/imaging`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { brightness: 200 } }),
      });
      const guessedBody = await guessed.json();
      check('an omitted channel is refused rather than guessed',
        guessed.status >= 400 && Boolean(guessedBody.error),
        `status=${guessed.status} ${JSON.stringify(guessedBody).slice(0, 150)}`);

      await fetch(`${BASE}/api/session/${dvr.sessionId}/disconnect`, { method: 'POST' });
    }
  }

  console.log('\nSingle-camera behaviour is unchanged');
  {
    // Adaptive means a normal camera must look exactly as it did before.
    const solo = await fetch(`${BASE}/api/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: MOCK_PORT, username: 'admin', password: 'admin' }),
    });
    const one = await solo.json();
    check('a single camera is not flagged multi-channel', one.isMultiChannel === false,
      `isMultiChannel=${one.isMultiChannel}`);
    check('a single camera still reports exactly one source',
      Array.isArray(one.sources) && one.sources.length === 1, `sources=${one.sources?.length}`);
    if (one.sessionId) {
      const legacyUrls = await (await fetch(`${BASE}/api/session/${one.sessionId}/stream-urls`)).json();
      check('single-camera stream URLs are unchanged when profile is omitted',
        legacyUrls.urls?.length === one.profiles?.length,
        `urls=${legacyUrls.urls?.length} profiles=${one.profiles?.length}`);
      // The convenience default must survive for one-camera devices.
      const noProfile = await fetch(`${BASE}/api/session/${one.sessionId}/imaging`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { brightness: 120 } }),
      });
      check('a single camera still accepts an omitted profile', noProfile.status === 200,
        `status=${noProfile.status}`);
      await fetch(`${BASE}/api/session/${one.sessionId}/disconnect`, { method: 'POST' });
    }
  }

  console.log('\nStatic assets');
  for (const asset of ['/', '/js/app.js', '/js/player.js', '/js/spring.js', '/styles/tokens.css', '/styles/app.css', '/styles/player.css', '/styles/imaging.css']) {
    const res = await fetch(`${BASE}${asset}`);
    check(`serves ${asset}`, res.ok, `got ${res.status}`);
  }
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  check('index links tokens.css', indexHtml.includes('tokens.css'));
  check('index links player.css', indexHtml.includes('player.css'));
  check('index loads app.js as a module', /type=["']module["'][^>]*app\.js|app\.js[^>]*type=["']module["']/.test(indexHtml));

  console.log('\nAuth failure path');
  const rejectMock = start('mock-401', ['tools/mock-camera.js', String(MOCK_PORT + 1)], { MOCK_REJECT_AUTH: '1' });
  await delay(1200);
  const unauth = await fetch(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: MOCK_PORT + 1, username: 'admin', password: 'nope' }),
  });
  const unauthBody = await unauth.json();
  check('rejected credentials return UNAUTHORIZED', unauthBody.error?.code === 'UNAUTHORIZED', JSON.stringify(unauthBody).slice(0, 200));
  // Deliberately NOT vendor-specific. Most devices refuse GetDeviceInformation
  // until authenticated, so at failure time we have no evidence of the make —
  // an earlier version asserted Hikvision on every auth failure and told an
  // operator the wrong thing about an OEM recorder.
  const authHint = unauthBody.error?.hint ?? '';
  check('unauthorized explains the cause without naming a vendor',
    /ONVIF account|ONVIF user|integration protocol/i.test(authHint) && !/hikvision|dahua|axis/i.test(authHint),
    authHint || 'no hint');
  rejectMock.kill('SIGKILL');

  console.log('\nUnreachable host path');
  const refused = await fetch(`${BASE}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: 9, username: 'a', password: 'b' }),
  });
  const refusedBody = await refused.json();
  check('connection refused maps to DEVICE_UNREACHABLE or DEVICE_TIMEOUT',
    ['DEVICE_UNREACHABLE', 'DEVICE_TIMEOUT'].includes(refusedBody.error?.code),
    JSON.stringify(refusedBody).slice(0, 200));
  check('unreachable carries an actionable hint', Boolean(refusedBody.error?.hint));

  console.log('\nVendor CGI mock (Vatilon protocol fidelity, VENDOR.md)');
  // Tests the mock itself over plain HTTP — the driver is built by another
  // work stream and must not be imported from here. If the mock is lenient
  // where the real camera is strict, the driver passes here and fails in the
  // field, so these checks assert the strict behaviours directly.
  {
    const md5 = (s) => createHash('md5').update(s).digest('hex');
    const VENDOR_PORT = MOCK_PORT + 10;
    const VBASE = (port) => `http://127.0.0.1:${port}/cgi-bin/web.cgi`;
    const DIGEST = {
      realm: 'CAMERA',
      nonce: 'b6ef824ee4090bbd124a4ccb39c5333a',
      qop: 'auth',
      nc: '00000001',
      // HA2 covers this uri, never the one actually requested (VENDOR.md §1).
      uri: '/cgi-bin/web.cgi?mod=account&cmd=check',
    };
    function digestHeader(username, password, uri = DIGEST.uri) {
      const cnonce = randomBytes(8).toString('hex');
      const ha1 = md5(`${username}:${DIGEST.realm}:${password}`);
      const ha2 = md5(`GET:${uri}`);
      const response = md5(`${ha1}:${DIGEST.nonce}:${DIGEST.nc}:${cnonce}:${DIGEST.qop}:${ha2}`);
      return `Digest username="${username}", realm="${DIGEST.realm}", nonce="${DIGEST.nonce}", `
        + `uri="${uri}", qop=${DIGEST.qop}, nc=${DIGEST.nc}, cnonce="${cnonce}", response="${response}"`;
    }
    const vendorLogin = (port, password = 'admin', uri) => fetch(`${VBASE(port)}?mod=session&cmd=login1`, {
      headers: { Authorization: digestHeader('admin', password, uri) },
    });
    const vendorGet = (port, sid) => fetch(`${VBASE(port)}?mod=image&cmd=get`, { headers: { 'Session-Id': sid } });
    const vendorSet = (port, sid, body, contentType = 'application/json') => fetch(VBASE(port), {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Session-Id': sid },
      body,
    });

    start('mock-vendor', ['tools/mock-vendor-camera.js', String(VENDOR_PORT)]);
    start('mock-vendor-ignore', ['tools/mock-vendor-camera.js', String(VENDOR_PORT + 1)], { MOCK_VENDOR_MODE: 'ignore' });
    start('mock-vendor-expire', ['tools/mock-vendor-camera.js', String(VENDOR_PORT + 2)], { MOCK_VENDOR_MODE: 'expire' });
    if (!await waitForPort(`http://127.0.0.1:${VENDOR_PORT}/__calls`)
      || !await waitForPort(`http://127.0.0.1:${VENDOR_PORT + 1}/__calls`)
      || !await waitForPort(`http://127.0.0.1:${VENDOR_PORT + 2}/__calls`)) {
      console.error('Vendor mocks did not come up. Run with VERBOSE=1 to see why.');
      process.exit(1);
    }

    const login = await vendorLogin(VENDOR_PORT);
    const sid = login.headers.get('session-id');
    check('hand-rolled digest logs in', login.status === 200, `got ${login.status}`);
    check('login returns a Session-Id response header', typeof sid === 'string' && sid.length > 0);

    // A correct STANDARD digest: HA2 over the requested uri. The real device
    // rejects it because it computes HA2 over the hardcoded account/check uri.
    const standard = await vendorLogin(VENDOR_PORT, 'admin', '/cgi-bin/web.cgi?mod=session&cmd=login1');
    check('a correct STANDARD digest is rejected', standard.status !== 200 && !standard.headers.get('session-id'),
      `got ${standard.status}`);

    const wrongPassword = await vendorLogin(VENDOR_PORT, 'wrong');
    check('a wrong password is rejected', wrongPassword.status !== 200 && !wrongPassword.headers.get('session-id'),
      `got ${wrongPassword.status}`);

    const noSession = await fetch(`${VBASE(VENDOR_PORT)}?mod=image&cmd=get`);
    check('a request without Session-Id is rejected', (await noSession.text()) === 'unknown error happened',
      `got ${noSession.status}`);

    const getRes = await vendorGet(VENDOR_PORT, sid);
    const img = await getRes.json();
    const SCALARS = ['brightness', 'contrast', 'saturation', 'sharpness', 'exposure', 'day_night_mode',
      'wdr_enable', 'mirror', 'flip', 'rotation', 'nr_enable', 'mwb_red', 'mwb_blue', 'mwb_green'];
    check('image get returns the documented scalar fields',
      SCALARS.every((f) => typeof img[f] === 'number'), JSON.stringify(img).slice(0, 250));
    check('scalars default to 128 within 0..255',
      SCALARS.every((f) => img[f] === 128), JSON.stringify(img).slice(0, 250));
    check('image get returns nested day_begin and day_end objects',
      typeof img.day_begin === 'object' && img.day_begin !== null
      && typeof img.day_end === 'object' && img.day_end !== null);

    const OK_BODY = JSON.stringify({ status: 'ok', data: '' });
    const setBody = (param2) => JSON.stringify({ mod: 'image', cmd: 'set', param: { channel: 0 }, param2 });
    const setRes = await vendorSet(VENDOR_PORT, sid, setBody({ ...img, brightness: 200 }));
    check('a correct two-param set returns ok JSON', setRes.status === 200 && (await setRes.text()) === OK_BODY);
    const afterSet = await (await vendorGet(VENDOR_PORT, sid)).json();
    check('a correct two-param set applies and reads back', afterSet.brightness === 200, JSON.stringify(afterSet).slice(0, 150));

    const oneParam = await vendorSet(VENDOR_PORT, sid, JSON.stringify({ mod: 'image', cmd: 'set', param: { channel: 0 } }));
    const oneParamText = await oneParam.text();
    check('a one-param set returns the bare text "param num error"',
      oneParam.status === 200 && oneParamText === 'param num error', `got ${oneParam.status} ${oneParamText}`);

    const changedOnly = await vendorSet(VENDOR_PORT, sid, setBody({ brightness: 100 }));
    check('a set carrying only the changed field is rejected',
      changedOnly.status === 200 && (await changedOnly.text()) === 'param num error');

    const formEncoded = await vendorSet(VENDOR_PORT, sid, 'mod=image&cmd=set&param=channel', 'application/x-www-form-urlencoded');
    check('a form-encoded set is rejected',
      formEncoded.status === 200 && (await formEncoded.text()) === 'param num error');

    const unknownMod = await fetch(`${VBASE(VENDOR_PORT)}?mod=ptz&cmd=move`, { headers: { 'Session-Id': sid } });
    check('an unrecognized module returns the bare text "unknown error happened"',
      unknownMod.status === 200 && (await unknownMod.text()) === 'unknown error happened');

    // Ignore mode: the ONVIF Imaging disease reproduced on the CGI. A driver
    // that trusts the HTTP status instead of reading back must be caught.
    const iLogin = await vendorLogin(VENDOR_PORT + 1);
    const iSid = iLogin.headers.get('session-id');
    const iBefore = await (await vendorGet(VENDOR_PORT + 1, iSid)).json();
    const iSet = await vendorSet(VENDOR_PORT + 1, iSid, setBody({ ...iBefore, brightness: 90 }));
    check('ignore-mode set returns ok', iSet.status === 200 && (await iSet.text()) === OK_BODY);
    const iAfter = await (await vendorGet(VENDOR_PORT + 1, iSid)).json();
    check('ignore-mode write changes nothing on read-back', iAfter.brightness === iBefore.brightness,
      `before=${iBefore.brightness} after=${iAfter.brightness}`);

    // Expire mode: the session dies after the first authenticated request.
    const eLogin = await vendorLogin(VENDOR_PORT + 2);
    const eSid = eLogin.headers.get('session-id');
    const eFirst = await vendorGet(VENDOR_PORT + 2, eSid);
    check('expire mode serves the first authenticated request',
      eFirst.status === 200 && typeof (await eFirst.json()).brightness === 'number');
    const eSecond = await vendorGet(VENDOR_PORT + 2, eSid);
    check('expire mode kills the session after one request',
      (await eSecond.text()) === 'unknown error happened');
    const eRelogin = await vendorLogin(VENDOR_PORT + 2);
    const eSid2 = eRelogin.headers.get('session-id');
    check('re-login after expiry succeeds', eRelogin.status === 200 && Boolean(eSid2) && eSid2 !== eSid);
    const eThird = await vendorGet(VENDOR_PORT + 2, eSid2);
    check('the fresh session works after re-login',
      eThird.status === 200 && typeof (await eThird.json()).brightness === 'number');
  }

  console.log('\nDisconnect and process hygiene');
  if (session.capabilities?.ptz) {
    // Start a move, then disconnect mid-flight: teardown must stop the camera.
    await resetCalls();
    await fetch(`${BASE}/api/session/${id}/ptz/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, pan: 0.5, tilt: 0.2, zoom: 0 }),
    });
  }
  const disconnect = await fetch(`${BASE}/api/session/${id}/disconnect`, { method: 'POST' });
  if (session.capabilities?.ptz) {
    await delay(600);
    const afterTeardown = await calls();
    check('disconnecting mid-move stops the camera', (afterTeardown.Stop ?? 0) >= 1,
      JSON.stringify(afterTeardown));
  }
  check('disconnect returns 204', disconnect.status === 204);
  const afterDisconnect = await fetch(`${BASE}/api/session/${id}`);
  check('session is gone after disconnect', afterDisconnect.status === 404);

  await delay(500);
  const { execSync } = await import('node:child_process');
  let orphans = '';
  try {
    // Scoped to the mock's own RTSP endpoint: a real camera stream running in
    // another process on this machine is not this test's business.
    orphans = execSync(`pgrep -fl "fake-ffmpeg|rtsp://[^ ]*127.0.0.1:8554" || true`, { encoding: 'utf8' }).trim();
  } catch { /* pgrep exits 1 when nothing matches */ }
  check('no orphaned ffmpeg processes', orphans === '', orphans.slice(0, 200));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke run crashed:', err);
  cleanup();
  process.exit(1);
});
