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
import { setTimeout as delay } from 'node:timers/promises';
import WsClient from 'ws';
import path from 'node:path';

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

async function main() {
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
  check('unauthorized carries a Hikvision-specific hint', /ONVIF user/i.test(unauthBody.error?.hint ?? ''), unauthBody.error?.hint ?? 'no hint');
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
