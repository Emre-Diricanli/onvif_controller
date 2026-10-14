/**
 * Dahua / Lorex adapter checks (ADAPTERS.md §8): conformance against the
 * IPC-HDW2431T camera and Lorex N864A6 recorder personas, plus adapter-
 * specific behaviour — the key=value parser, encoder writes on a stream
 * target, recorder channel isolation, per-request rejection, enum mapping,
 * and probe isolation against other vendors' personas.
 */
import { existsSync } from 'node:fs';
import { createChecker, runConformance, startPersona, HARNESS_CREDENTIALS } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/dahua/index.js';
import { parseKeyValue, parseTable, isErrorBody, isOkBody } from '../../server/adapters/dahua/kv.js';
import { persona as ipcPersona } from '../personas/dahua-ipc.js';
import { persona as lorexPersona } from '../personas/lorex-n864.js';
import { persona as axisPersona } from '../personas/axis-p3245.js';
import { persona as reolinkPersona } from '../personas/reolink-rlc810.js';
import { persona as univiewPersona } from '../personas/uniview-ipc.js';

const t = createChecker('dahua');
const configFor = (p) => ({ host: p.host, port: p.port, ...HARNESS_CREDENTIALS, timeoutMs: 4000 });

async function withDevice(persona, mode, fn) {
  const p = await startPersona(persona, { mode });
  let conn = null;
  try {
    conn = await adapter.connect(configFor(p));
    await fn(conn, p);
  } catch (err) {
    t.check(`${persona.name}/${mode}: ran without throwing`, false, `${err?.code ?? ''} ${err?.message ?? err}`);
  } finally {
    try { conn?.close(); } catch { /* close never throws */ }
    await p.close();
  }
}

// --- the text format ---
t.section('key=value parser');
{
  const kv = parseKeyValue('\r\ntable.ChannelTitle[0].Name=Gate=North\r\n\r\ntype=IPC-X\nversion=2.800.0,build:2020-01-01\r\nnot a pair\r\n');
  t.check('parser: splits on the first "=" only', kv.get('table.ChannelTitle[0].Name') === 'Gate=North', JSON.stringify([...kv]));
  t.check('parser: CRLF, LF and blank lines', kv.get('type') === 'IPC-X' && kv.get('version') === '2.800.0,build:2020-01-01' && kv.size === 3,
    JSON.stringify([...kv]));
  const table = parseTable('table.VideoColor[0][0].Brightness=50\r\n');
  t.check('parser: getConfig keys lose the "table." prefix', table.get('VideoColor[0][0].Brightness') === '50');
  t.check('parser: Error body detected', isErrorBody('Error\r\nBad Request!\r\n') && !isErrorBody('OK\r\n'));
  t.check('parser: OK body detected', isOkBody('OK\r\n') && !isOkBody('Error'));
}

await runConformance(t, {
  adapter,
  persona: ipcPersona,
  sample: { scope: 'channel', key: 'image.brightness', value: 70 }, // persona default is 50
});

await runConformance(t, {
  adapter,
  persona: lorexPersona,
  sample: { scope: 'channel', key: 'image.brightness', value: 70 }, // channel 1 persona default is 40
});

// --- identity and targets ---
t.section('identity and targets');
await withDevice(lorexPersona, 'default', async (conn) => {
  t.check('lorex: model from getDeviceType', conn.info.model === 'N864A6', JSON.stringify(conn.info));
  t.check('lorex: vendor from getVendor', conn.info.vendor === 'Lorex', JSON.stringify(conn.info));
  t.check('lorex: firmware and serial', conn.info.firmware?.startsWith('4.001') && conn.info.serial === 'ND0221070012345', JSON.stringify(conn.info));
  const targets = await conn.listTargets();
  const channels = targets.filter((x) => x.scope === 'channel');
  t.check('lorex: 8 channels from MaxRemoteInputChannels', channels.length === 8, channels.map((c) => c.id).join(','));
  t.check('lorex: channel 1 named from ChannelTitle[0]', channels[0]?.label === 'Front Door' && channels[0]?.channel === 1, JSON.stringify(channels[0]));
  const sub3 = targets.find((x) => x.id === 'stream:3:sub');
  t.check('lorex: stream:3:sub has parent channel:3', sub3?.scope === 'stream' && sub3?.parent === 'channel:3' && sub3?.channel === 3, JSON.stringify(sub3));
});
await withDevice(ipcPersona, 'default', async (conn) => {
  const targets = await conn.listTargets();
  t.check('ipc: one channel, main + sub streams', targets.map((x) => x.id).join(',') === 'channel:1,stream:1:main,stream:1:sub',
    targets.map((x) => x.id).join(','));
  const ds = await conn.describeSettings('channel:1');
  const sharp = ds.find((d) => d.key === 'image.sharpness');
  t.check('ipc: sharpness described from VideoInSharpness', sharp?.resource === 'VideoInSharpness:0' && sharp.max === 100, JSON.stringify(sharp));
  const es = await conn.describeSettings('stream:1:main');
  t.check('ipc: bitrate in kbps on Encode:0:main', es.find((d) => d.key === 'video.bitrate')?.unit === 'kbps'
    && es.find((d) => d.key === 'video.bitrate')?.resource === 'Encode:0:main', JSON.stringify(es));
  const r = await conn.read('stream:1:main');
  t.check('ipc: main stream read maps natives', r.values['video.codec'] === 'H.265' && r.values['video.resolution'] === '2688x1520'
    && r.values['video.bitrateMode'] === 'vbr' && r.values['video.fps'] === 20 && r.values['video.gop'] === 40, JSON.stringify(r.values));
});

// --- encoder write on a stream target ---
t.section('encoder: stream target write');
await withDevice(lorexPersona, 'default', async (conn, p) => {
  const setsBefore = p.callCounts.setConfig ?? 0;
  const w = await conn.write('stream:2:main', { 'video.bitrate': 8192, 'video.fps': 12 });
  t.check('encoder: bitrate applied', w.results['video.bitrate']?.outcome === 'applied', JSON.stringify(w.results));
  t.check('encoder: fps applied', w.results['video.fps']?.outcome === 'applied', JSON.stringify(w.results));
  t.check('encoder: one setConfig for one resource', (p.callCounts.setConfig ?? 0) - setsBefore === 1, `${(p.callCounts.setConfig ?? 0) - setsBefore}`);
  const r = await conn.read('stream:2:main', ['video.bitrate', 'video.fps']);
  t.check('encoder: read-back shows 8192 kbps @ 12 fps', r.values['video.bitrate'] === 8192 && r.values['video.fps'] === 12, JSON.stringify(r.values));
  const sub = await conn.read('stream:2:sub', ['video.bitrate']);
  t.check('encoder: sub stream of that channel untouched', sub.values['video.bitrate'] === 384 + 32, JSON.stringify(sub.values));
  const other = await conn.read('stream:1:main', ['video.bitrate']);
  t.check('encoder: other channel untouched', other.values['video.bitrate'] === 6144, JSON.stringify(other.values));

  const codec = await conn.write('stream:2:sub', { 'video.codec': 'MJPEG', 'video.bitrateMode': 'vbr' });
  t.check('encoder: codec MJPEG (native MJPG) applied', codec.results['video.codec']?.outcome === 'applied', JSON.stringify(codec.results));
  t.check('encoder: bitrateMode vbr applied', codec.results['video.bitrateMode']?.outcome === 'applied', JSON.stringify(codec.results));
  const res = await conn.write('stream:2:sub', { 'video.resolution': '704x480' });
  t.check('encoder: resolution writes Width+Height together', res.results['video.resolution']?.outcome === 'applied', JSON.stringify(res.results));
  let bad = null;
  try { await conn.write('stream:2:sub', { 'video.resolution': 'big' }); } catch (err) { bad = err; }
  t.check('encoder: malformed resolution -> BAD_REQUEST', bad?.code === 'BAD_REQUEST', bad?.message);
});

// --- recorder channel isolation ---
t.section('recorder channel isolation');
await withDevice(lorexPersona, 'default', async (conn) => {
  const before = await conn.read('channel:1', ['image.brightness', 'image.contrast']);
  t.check('isolation: channel 1 default brightness is 40', before.values['image.brightness'] === 40, JSON.stringify(before.values));
  const w = await conn.write('channel:3', { 'image.brightness': 77, 'image.contrast': 61 });
  t.check('isolation: channel 3 write applied', w.results['image.brightness']?.outcome === 'applied'
    && w.results['image.contrast']?.outcome === 'applied', JSON.stringify(w.results));
  const after = await conn.read('channel:1', ['image.brightness', 'image.contrast']);
  t.check('isolation: channel 1 unchanged', JSON.stringify(after.values) === JSON.stringify(before.values),
    `before ${JSON.stringify(before.values)}, after ${JSON.stringify(after.values)}`);
  const ch3 = await conn.read('channel:3', ['image.brightness']);
  t.check('isolation: channel 3 holds the new value', ch3.values['image.brightness'] === 77, JSON.stringify(ch3.values));
});

// --- device refusal -> rejected ---
t.section('device rejection -> rejected');
await withDevice(ipcPersona, 'reject', async (conn) => {
  const w = await conn.write('channel:1', { 'image.brightness': 80 });
  t.check('reject: outcome is rejected', w.results['image.brightness']?.outcome === 'rejected', JSON.stringify(w.results));
  const r = await conn.read('channel:1', ['image.brightness']);
  t.check('reject: value unchanged on the device', r.values['image.brightness'] === 50, JSON.stringify(r.values));
});

// --- enum and bool mapping ---
t.section('enum mapping');
await withDevice(ipcPersona, 'default', async (conn) => {
  const r0 = await conn.read('channel:1', ['image.dayNight']);
  t.check('enum: native 1 reads as auto', r0.values['image.dayNight'] === 'auto', JSON.stringify(r0.values));
  for (const value of ['night', 'day', 'auto']) {
    const w = await conn.write('channel:1', { 'image.dayNight': value });
    const r = await conn.read('channel:1', ['image.dayNight']);
    t.check(`enum: dayNight ${value} round-trips`, w.results['image.dayNight']?.outcome === 'applied' && r.values['image.dayNight'] === value,
      `${JSON.stringify(w.results)} ${JSON.stringify(r.values)}`);
  }
  const m = await conn.write('channel:1', { 'image.mirror': true, 'image.flip': true, 'image.sharpness': 65 });
  t.check('bool: mirror + flip applied, sharpness in its own resource applied',
    ['image.mirror', 'image.flip', 'image.sharpness'].every((k) => m.results[k]?.outcome === 'applied'), JSON.stringify(m.results));
  let bad = null;
  try { await conn.write('channel:1', { 'image.dayNight': 'dusk' }); } catch (err) { bad = err; }
  t.check('enum: unknown value -> BAD_REQUEST', bad?.code === 'BAD_REQUEST');
});

// --- cross-vendor probe isolation ---
t.section('cross-vendor probe isolation');
const others = [['axis-p3245', axisPersona], ['reolink-rlc810', reolinkPersona], ['uniview-ipc', univiewPersona]];
const hikPath = new URL('../personas/hikvision-ds2cd.js', import.meta.url);
if (existsSync(hikPath)) {
  const { persona: hikPersona } = await import(hikPath.href);
  others.push(['hikvision-ds2cd', hikPersona]);
}
for (const [name, persona] of others) {
  const p = await startPersona(persona);
  try {
    const res = await adapter.probe(configFor(p)).catch((err) => ({ threw: err }));
    t.check(`probe does not match ${name}`, res?.match === false, JSON.stringify(res));
  } finally {
    await p.close();
  }
}
{
  const p = await startPersona(ipcPersona);
  try {
    const res = await adapter.probe({ ...configFor(p), password: 'wrong' });
    t.check('probe: a 401 alone is not a match', res?.match === false, JSON.stringify(res));
    const ok = await adapter.probe(configFor(p));
    t.check('probe: reports model and firmware', ok.model === 'IPC-HDW2431T-AS-S2' && ok.firmware?.startsWith('2.800'), JSON.stringify(ok));
  } finally {
    await p.close();
  }
}

t.done();
process.exit(t.failed ? 1 : 0);
