/**
 * Reolink adapter checks (ADAPTERS.md §8): conformance against the RLC-810A
 * camera and RLN8-410 NVR personas, plus adapter-specific behaviour — encoder
 * mapping on a stream target, transparent re-login on token expiry, NVR
 * channel isolation, per-field rejection, enum mapping, and probe isolation
 * against other vendors' personas.
 */
import { createChecker, runConformance, startPersona, HARNESS_CREDENTIALS } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/reolink/index.js';
import { persona as camPersona } from '../personas/reolink-rlc810.js';
import { persona as nvrPersona } from '../personas/reolink-nvr.js';
import { persona as axisPersona } from '../personas/axis-p3245.js';
import { persona as univiewPersona } from '../personas/uniview-ipc.js';

const t = createChecker('reolink');

const configFor = (p) => ({ host: p.host, port: p.port, ...HARNESS_CREDENTIALS, timeoutMs: 4000 });

await runConformance(t, {
  adapter,
  persona: camPersona,
  sample: { scope: 'channel', key: 'image.brightness', value: 70 }, // persona default is 128
});

await runConformance(t, {
  adapter,
  persona: nvrPersona,
  sample: { scope: 'channel', key: 'image.brightness', value: 70 }, // channel 1 persona default is 100
});

// --- encoder write on a stream target (NVR, channel 2 main) ---
t.section('encoder: stream target write on the NVR');
{
  const p = await startPersona(nvrPersona);
  const conn = await adapter.connect(configFor(p));
  try {
    const w = await conn.write('stream:2.main', { 'video.bitrate': 8192, 'video.fps': 15 });
    t.check('encoder: bitrate applied', w.results['video.bitrate']?.outcome === 'applied', JSON.stringify(w.results));
    t.check('encoder: fps applied', w.results['video.fps']?.outcome === 'applied', JSON.stringify(w.results));
    const r = await conn.read('stream:2.main');
    t.check('encoder: codec maps h264 -> H.264', r.values['video.codec'] === 'H.264', JSON.stringify(r.values));
    t.check('encoder: 2560*1440 reads as 2560x1440', r.values['video.resolution'] === '2560x1440', JSON.stringify(r.values));
    t.check('encoder: read-back bitrate is 8192', r.values['video.bitrate'] === 8192, JSON.stringify(r.values));
    // Only mainStream was asked to change; the sub stream of the same channel
    // must hold its persona default (channel 2 sub = 512 + 1*128).
    const sub = await conn.read('stream:2.sub', ['video.bitrate']);
    t.check('encoder: sub stream of the channel untouched', sub.values['video.bitrate'] === 640, JSON.stringify(sub.values));
  } finally {
    conn.close();
    await p.close();
  }
}

// --- token expiry: one transparent re-login, then the request succeeds ---
t.section('token expiry: transparent re-login');
{
  const p = await startPersona(camPersona, { mode: 'expire' });
  const conn = await adapter.connect(configFor(p));
  try {
    const loginsBefore = p.callCounts.Login ?? 0;
    const w = await conn.write('channel:1', { 'image.brightness': 90 });
    t.check('expire: write applied after re-login', w.results['image.brightness']?.outcome === 'applied', JSON.stringify(w.results));
    t.check('expire: Login was called more than once', (p.callCounts.Login ?? 0) > loginsBefore,
      `Login count stayed ${p.callCounts.Login ?? 0}`);
  } finally {
    conn.close();
    await p.close();
  }
}

// --- NVR channel isolation: a write to channel 3 must not touch channel 1 ---
t.section('NVR channel isolation');
{
  const p = await startPersona(nvrPersona);
  const conn = await adapter.connect(configFor(p));
  try {
    const before = await conn.read('channel:1', ['image.brightness']);
    t.check('isolation: channel 1 persona default is 100', before.values['image.brightness'] === 100,
      JSON.stringify(before.values));
    const w = await conn.write('channel:3', { 'image.brightness': 150 });
    t.check('isolation: channel 3 write applied', w.results['image.brightness']?.outcome === 'applied', JSON.stringify(w.results));
    const after = await conn.read('channel:1', ['image.brightness']);
    t.check('isolation: channel 1 unchanged', after.values['image.brightness'] === before.values['image.brightness'],
      `before ${before.values['image.brightness']}, after ${after.values['image.brightness']}`);
    const ch3 = await conn.read('channel:3', ['image.brightness']);
    t.check('isolation: channel 3 has the new value', ch3.values['image.brightness'] === 150, JSON.stringify(ch3.values));
  } finally {
    conn.close();
    await p.close();
  }
}

// --- device error body -> per-field 'rejected', not a throw ---
t.section('device rejection -> rejected');
{
  const p = await startPersona(camPersona, { mode: 'reject' });
  const conn = await adapter.connect(configFor(p));
  try {
    const w = await conn.write('channel:1', { 'image.brightness': 80 });
    t.check('reject: outcome is rejected', w.results['image.brightness']?.outcome === 'rejected', JSON.stringify(w.results));
  } finally {
    conn.close();
    await p.close();
  }
}

// --- enum mapping: canonical <-> native on the wire ---
t.section('enum mapping');
{
  const p = await startPersona(camPersona);
  const conn = await adapter.connect(configFor(p));
  try {
    const w = await conn.write('channel:1', { 'image.dayNight': 'night' });
    t.check('enum: dayNight night applied', w.results['image.dayNight']?.outcome === 'applied', JSON.stringify(w.results));
    const r = await conn.read('channel:1', ['image.dayNight']);
    t.check('enum: native Black&White maps back to night', r.values['image.dayNight'] === 'night', JSON.stringify(r.values));
    const enc = await conn.read('stream:1.main', ['video.resolution']);
    t.check('enum: 2560*1440 reads as 2560x1440', enc.values['video.resolution'] === '2560x1440', JSON.stringify(enc.values));
  } finally {
    conn.close();
    await p.close();
  }
}

// --- cross-vendor probe isolation ---
t.section('cross-vendor probe isolation');
for (const [name, persona] of [['axis-p3245', axisPersona], ['uniview-ipc', univiewPersona]]) {
  const p = await startPersona(persona);
  try {
    const res = await adapter.probe(configFor(p)).catch((err) => ({ threw: err }));
    t.check(`probe does not match ${name}`, res?.match === false, JSON.stringify(res));
  } finally {
    await p.close();
  }
}

t.done();
