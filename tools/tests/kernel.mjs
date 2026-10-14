/**
 * Kernel tests: the protocol-neutral settings API end to end (API.md
 * "Settings", ADAPTERS.md §6, §9).
 *
 *   - ONVIF through the adapter: targets, descriptors, read, applied write,
 *     encoder write, and the stub signature surfacing as `unchanged`.
 *   - Vendor-only connect: for every vendor persona whose adapter is
 *     installed, POST /api/connect with protocol "auto" finds the device in
 *     its own API and the settings surface works. ONVIF-only routes refuse.
 *   - Cross-protocol probe isolation: no adapter claims another vendor's
 *     persona.
 *   - The stub fallback: ONVIF ignores an imaging write on a single-source
 *     camera, a vendor adapter on the same host applies it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createChecker, startPersona } from '../adapter-harness.mjs';
import { listAdapters, probeAll, clearProbeCache } from '../../server/adapters/index.js';
import { listPersonas } from '../personas/index.js';

const t = createChecker('kernel: protocol-neutral settings');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

function start(args, env = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await delay(150);
  }
  return false;
}

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function bootApp(port, env = {}) {
  start(['server/index.js'], { PORT: String(port), HOST: '127.0.0.1', FFMPEG_PATH: path.resolve('tools/fake-ffmpeg.mjs'), ...env });
  const base = `http://127.0.0.1:${port}`;
  return (await waitFor(`${base}/api/health`)) ? base : null;
}

// ------------------------------------------------------------------ ONVIF
const MOCK = 10301;
start(['tools/mock-camera.js', String(MOCK)]);
start(['tools/mock-camera.js', String(MOCK + 1)], { MOCK_IMAGING_MODE: 'ignore' });
const base = await bootApp(8301);
t.check('app started', Boolean(base));

const adaptersRes = await api(base, 'GET', '/api/adapters');
t.check('GET /api/adapters lists onvif', adaptersRes.json?.adapters?.some((a) => a.id === 'onvif'), JSON.stringify(adaptersRes.json));

t.section('ONVIF through the settings API');
const conn = await api(base, 'POST', '/api/connect', { host: '127.0.0.1', port: MOCK, username: 'admin', password: 'admin' });
const sid = conn.json?.sessionId;
t.check('ONVIF connect works unchanged', conn.status === 200 && typeof sid === 'string', JSON.stringify(conn.json).slice(0, 200));
t.check('session reports protocol onvif', conn.json?.protocol === 'onvif');

const targets = await api(base, 'GET', `/api/session/${sid}/targets`);
const list = targets.json?.targets ?? [];
const source = list.find((x) => x.scope === 'source');
const stream = list.find((x) => x.scope === 'stream');
t.check('targets include a source and a stream', Boolean(source && stream), JSON.stringify(list));

const described = await api(base, 'GET', `/api/session/${sid}/settings/describe?target=${encodeURIComponent(source?.id)}`);
const bright = described.json?.descriptors?.find((d) => d.key === 'image.brightness');
t.check('imaging descriptors come from the device', bright?.writable === true && typeof bright.max === 'number', JSON.stringify(described.json).slice(0, 300));

const read = await api(base, 'GET', `/api/session/${sid}/settings?target=${encodeURIComponent(source?.id)}`);
t.check('read returns canonical keys and source', typeof read.json?.values?.['image.brightness'] === 'number' && read.json?.source === 'onvif', JSON.stringify(read.json));

const want = read.json?.values?.['image.brightness'] === 60 ? 61 : 60;
const write = await api(base, 'PATCH', `/api/session/${sid}/settings`, { target: source?.id, values: { 'image.brightness': want } });
t.check('ONVIF imaging write is applied', write.json?.results?.['image.brightness']?.outcome === 'applied', JSON.stringify(write.json));

const bad = await api(base, 'PATCH', `/api/session/${sid}/settings`, { target: source?.id, values: { 'image.brightness': 1e9 } });
t.check('out-of-range value is BAD_REQUEST before the wire', bad.status === 400 && bad.json?.error?.code === 'BAD_REQUEST');
const unknownTarget = await api(base, 'GET', `/api/session/${sid}/settings?target=nope`);
t.check('unknown target is 404 NOT_FOUND', unknownTarget.status === 404 && unknownTarget.json?.error?.code === 'NOT_FOUND');
const noTarget = await api(base, 'GET', `/api/session/${sid}/settings`);
t.check('missing target is BAD_REQUEST', noTarget.status === 400);

const enc = await api(base, 'GET', `/api/session/${sid}/settings/describe?target=${encodeURIComponent(stream?.id)}`);
const bitrate = enc.json?.descriptors?.find((d) => d.key === 'video.bitrate');
t.check('encoder descriptors include video.bitrate in kbps', bitrate?.unit === 'kbps', JSON.stringify(enc.json).slice(0, 300));
const numeric = enc.json?.descriptors?.find((d) => d.writable && (d.type === 'int' || d.type === 'number') && d.key.startsWith('video.'));
t.check('the stream has a writable numeric encoder setting', Boolean(numeric), JSON.stringify(enc.json?.descriptors));
if (numeric) {
  const cur = (await api(base, 'GET', `/api/session/${sid}/settings?target=${encodeURIComponent(stream.id)}`)).json?.values?.[numeric.key];
  const next = cur === numeric.min ? numeric.min + 1 : numeric.min;
  const w = await api(base, 'PATCH', `/api/session/${sid}/settings`, { target: stream.id, values: { [numeric.key]: next } });
  t.check(`ONVIF encoder write of ${numeric.key} is applied`, w.json?.results?.[numeric.key]?.outcome === 'applied', JSON.stringify(w.json));
  t.check('encoder write reports stream bookkeeping', typeof w.json?.streamsRestarted === 'number' && !('encoderPatch' in w.json));
}

t.section('the stub signature');
const stubConn = await api(base, 'POST', '/api/connect', { host: '127.0.0.1', port: MOCK + 1, username: 'admin', password: 'admin' });
const stubSid = stubConn.json?.sessionId;
const stubSource = (await api(base, 'GET', `/api/session/${stubSid}/targets`)).json?.targets?.find((x) => x.scope === 'source');
const stubWrite = await api(base, 'PATCH', `/api/session/${stubSid}/settings`, { target: stubSource?.id, values: { 'image.brightness': 61 } });
t.check('ignored ONVIF write is "unchanged", never "applied"', stubWrite.json?.results?.['image.brightness']?.outcome === 'unchanged', JSON.stringify(stubWrite.json));

// ------------------------------------------------------------- vendor-only
t.section('vendor-only devices');
const installed = new Set((await listAdapters()).map((a) => a.id));
const vendorPersonas = Object.values(listPersonas()).filter((p) => p.vendor && installed.has(p.vendor) && p.vendor !== 'onvif');
if (vendorPersonas.length === 0) {
  console.log('  (no vendor adapters installed yet — vendor-only checks skipped)');
}
const CREDS = { username: 'admin', password: 'Harness-Pass1' };
for (const persona of vendorPersonas) {
  const dev = await startPersona(persona, CREDS);
  try {
    const c = await api(base, 'POST', '/api/connect', { host: '127.0.0.1', port: dev.port, ...CREDS });
    const vs = c.json?.sessionId;
    t.check(`${persona.name}: auto connect finds the device as ${persona.vendor}`, c.status === 200 && c.json?.protocol === persona.vendor,
      JSON.stringify(c.json).slice(0, 200));
    if (!vs) continue;
    const vt = (await api(base, 'GET', `/api/session/${vs}/targets`)).json?.targets ?? [];
    t.check(`${persona.name}: lists targets`, vt.length > 0);
    const first = vt.find((x) => x.scope === 'channel' || x.scope === 'source') ?? vt[0];
    const r = await api(base, 'GET', `/api/session/${vs}/settings?target=${encodeURIComponent(first.id)}`);
    t.check(`${persona.name}: read through the kernel`, r.status === 200 && r.json?.source === persona.vendor, JSON.stringify(r.json).slice(0, 200));
    const onvifOnly = await api(base, 'GET', `/api/session/${vs}/device`);
    t.check(`${persona.name}: ONVIF-only route refuses with UNSUPPORTED`, onvifOnly.status === 501 && onvifOnly.json?.error?.code === 'UNSUPPORTED');
    const ptz = await api(base, 'POST', `/api/session/${vs}/ptz/stop`, { profile: 'x' });
    t.check(`${persona.name}: PTZ refuses with UNSUPPORTED`, ptz.status === 501);
    const bye = await api(base, 'POST', `/api/session/${vs}/disconnect`);
    t.check(`${persona.name}: disconnect works`, bye.status === 204);
  } finally {
    await dev.close();
  }
}

t.section('probe isolation');
for (const persona of vendorPersonas) {
  const dev = await startPersona(persona, CREDS);
  try {
    clearProbeCache();
    const results = await probeAll({ host: dev.host, port: dev.port, ...CREDS, timeoutMs: 3000 }, { useCache: false });
    const matched = results.filter((r) => r.match).map((r) => r.id);
    t.check(`${persona.name}: only ${persona.vendor} claims it`, matched.length === 1 && matched[0] === persona.vendor, matched.join(','));
  } finally {
    await dev.close();
  }
}

t.section('stub fallback to a vendor adapter');
const single = vendorPersonas.find((p) => !/nvr|n864|recorder/i.test(p.name));
if (!single) {
  console.log('  (no single-camera vendor persona installed — fallback check skipped)');
} else {
  const dev = await startPersona(single, { username: 'admin', password: 'admin' });
  const fbBase = await bootApp(8302, { VENDOR_HTTP_PORT: String(dev.port) });
  try {
    const c = await api(fbBase, 'POST', '/api/connect', { host: '127.0.0.1', port: MOCK + 1, username: 'admin', password: 'admin' });
    const fsid = c.json?.sessionId;
    const src = (await api(fbBase, 'GET', `/api/session/${fsid}/targets`)).json?.targets?.find((x) => x.scope === 'source');
    const d = (await api(fbBase, 'GET', `/api/session/${fsid}/settings/describe?target=${encodeURIComponent(src?.id)}`)).json?.descriptors ?? [];
    const b = d.find((x) => x.key === 'image.brightness');
    const value = Math.round(((b?.min ?? 0) + (b?.max ?? 100)) / 3);
    const w = await api(fbBase, 'PATCH', `/api/session/${fsid}/settings`, { target: src?.id, values: { 'image.brightness': value } });
    const outcome = w.json?.results?.['image.brightness']?.outcome;
    t.check(`ONVIF stub + ${single.vendor} on the same host: write lands via ${single.vendor}`,
      w.json?.source === single.vendor && w.json?.fallbackFrom === 'onvif' && ['applied', 'adjusted'].includes(outcome), JSON.stringify(w.json));
    const again = await api(fbBase, 'GET', `/api/session/${fsid}/settings?target=${encodeURIComponent(src?.id)}`);
    t.check('later reads of that target come from the vendor adapter', again.json?.source === single.vendor, JSON.stringify(again.json).slice(0, 200));
  } finally {
    await dev.close();
  }
}

t.done();
process.exit(t.failed ? 1 : 0);
