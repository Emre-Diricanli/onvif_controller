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
  start('app', ['server/index.js'], { PORT: String(APP_PORT), HOST: '127.0.0.1' });

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
  }

  console.log('\nDevice');
  const device = await fetch(`${BASE}/api/session/${id}/device`);
  const deviceBody = await device.json();
  check('device read works', device.status === 200, JSON.stringify(deviceBody).slice(0, 200));
  check('device info present', Boolean(deviceBody.info));
  check('device time block present', Boolean(deviceBody.time));
  check('relay outputs is an array', Array.isArray(deviceBody.relayOutputs));

  console.log('\nStatic assets');
  for (const asset of ['/', '/js/app.js', '/js/player.js', '/js/spring.js', '/styles/tokens.css', '/styles/app.css', '/styles/player.css']) {
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
  const disconnect = await fetch(`${BASE}/api/session/${id}/disconnect`, { method: 'POST' });
  check('disconnect returns 204', disconnect.status === 204);
  const afterDisconnect = await fetch(`${BASE}/api/session/${id}`);
  check('session is gone after disconnect', afterDisconnect.status === 404);

  await delay(500);
  const { execSync } = await import('node:child_process');
  let orphans = '';
  try {
    orphans = execSync('pgrep -fl "ffmpeg.*rtsp" || true', { encoding: 'utf8' }).trim();
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
