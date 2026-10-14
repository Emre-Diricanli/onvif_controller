/**
 * Hikvision ISAPI adapter: conformance (ADAPTERS.md §8) for the camera and the
 * NVR persona, plus the ISAPI-specific risks — whole-node PUT preserving
 * untouched elements, mirror/flip sharing one element, recorder channel
 * isolation, encoder writes, <ResponseStatus> refusals, and probe isolation
 * against the other vendors' personas.
 */
import { existsSync } from 'node:fs';
import { createChecker, runConformance, startPersona, HARNESS_CREDENTIALS } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/hikvision/index.js';
import { persona as camera } from '../personas/hikvision-ds2cd.js';
import { persona as nvr } from '../personas/hikvision-nvr.js';

const t = createChecker('hikvision');
const configFor = (dev) => ({ host: dev.host, port: dev.port, ...HARNESS_CREDENTIALS, timeoutMs: 4000 });

await runConformance(t, { adapter, persona: camera, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });
await runConformance(t, { adapter, persona: nvr, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });

t.section('camera: targets, imaging enums and shared elements');
{
  const dev = await startPersona(camera);
  const conn = await adapter.connect(configFor(dev));
  try {
    const targets = await conn.listTargets();
    t.check('camera exposes channel:1 and streams 101/102',
      ['channel:1', 'stream:101', 'stream:102'].every((x) => targets.some((y) => y.id === x)), targets.map((x) => x.id).join(','));
    t.check('info reports the model', conn.info.model === 'DS-2CD2143G2-I');

    const dn = await conn.write('channel:1', { 'image.dayNight': 'night' });
    t.check('image.dayNight=night applied', dn.results['image.dayNight'].outcome === 'applied', JSON.stringify(dn.results));

    const mirror = await conn.write('channel:1', { 'image.mirror': true });
    t.check('mirror alone -> applied', mirror.results['image.mirror'].outcome === 'applied');
    const flip = await conn.write('channel:1', { 'image.flip': true });
    const both = await conn.read('channel:1', ['image.mirror', 'image.flip']);
    t.check('setting flip keeps the earlier mirror (CENTER style)', flip.results['image.flip'].outcome === 'applied'
      && both.values['image.mirror'] === true && both.values['image.flip'] === true, JSON.stringify(both.values));
    const unmirror = await conn.write('channel:1', { 'image.mirror': false });
    const after = await conn.read('channel:1', ['image.mirror', 'image.flip']);
    t.check('clearing mirror keeps flip (UPDOWN style)', unmirror.results['image.mirror'].outcome === 'applied'
      && after.values['image.flip'] === true && after.values['image.mirror'] === false, JSON.stringify(after.values));

    const wdr = await conn.write('channel:1', { 'image.wdr': true, 'image.wdrLevel': 80 });
    t.check('WDR on + level in one resource -> both applied',
      wdr.results['image.wdr'].outcome === 'applied' && wdr.results['image.wdrLevel'].outcome === 'applied', JSON.stringify(wdr.results));

    const color = await conn.write('channel:1', { 'image.contrast': 33 });
    const colorAfter = await conn.read('channel:1', ['image.brightness', 'image.contrast', 'image.saturation']);
    t.check('whole-node PUT keeps untouched siblings (saturation unchanged)',
      color.results['image.contrast'].outcome === 'applied' && colorAfter.values['image.saturation'] === 50, JSON.stringify(colorAfter.values));
  } finally {
    conn.close();
    await dev.close();
  }
}

t.section('encoder writes on stream targets');
{
  const dev = await startPersona(camera);
  const conn = await adapter.connect(configFor(dev));
  try {
    const ds = await conn.describeSettings('stream:101');
    const res = ds.find((d) => d.key === 'video.resolution');
    t.check('resolution is an enum of device-reported pairs', res?.type === 'enum' && res.values.includes('1920x1080'), JSON.stringify(res));
    const w = await conn.write('stream:101', { 'video.bitrate': 3000, 'video.fps': 15 });
    t.check('VBR stream: bitrate (the cap) and fps applied',
      w.results['video.bitrate'].outcome === 'applied' && w.results['video.fps'].outcome === 'applied', JSON.stringify(w.results));
    const mode = await conn.write('stream:101', { 'video.bitrateMode': 'cbr', 'video.bitrate': 2500 });
    t.check('switching to CBR writes constantBitRate',
      mode.results['video.bitrateMode'].outcome === 'applied' && mode.results['video.bitrate'].outcome === 'applied', JSON.stringify(mode.results));
    const res2 = await conn.write('stream:101', { 'video.resolution': '1280x720', 'video.codec': 'H.264' });
    t.check('resolution + codec applied', Object.values(res2.results).every((r) => r.outcome === 'applied'), JSON.stringify(res2.results));
    const sub = await conn.read('stream:102');
    t.check('sub stream untouched by main-stream writes', sub.values['video.resolution'] === '640x360' && sub.values['video.bitrate'] === 512, JSON.stringify(sub.values));
    const oddFps = await conn.write('stream:101', { 'video.fps': 23 });
    t.check('a frame rate the device does not offer -> rejected, never applied', oddFps.results['video.fps'].outcome === 'rejected', JSON.stringify(oddFps.results));
  } finally {
    conn.close();
    await dev.close();
  }
}

t.section('NVR: channels and isolation');
{
  const dev = await startPersona(nvr);
  const conn = await adapter.connect(configFor(dev));
  try {
    const targets = await conn.listTargets();
    const channels = targets.filter((x) => x.scope === 'channel');
    t.check('NVR lists 4 channels from InputProxy', channels.length === 4, channels.map((x) => x.id).join(','));
    t.check('NVR channel labels come from the recorder', channels[2]?.label === 'Parking Lot', channels[2]?.label);
    t.check('streams carry their channel as parent', targets.find((x) => x.id === 'stream:301')?.parent === 'channel:3');
    const before1 = (await conn.read('channel:1', ['image.brightness'])).values['image.brightness'];
    const w = await conn.write('channel:3', { 'image.brightness': 90 });
    const after1 = (await conn.read('channel:1', ['image.brightness'])).values['image.brightness'];
    t.check('writing channel 3 applies there', w.results['image.brightness'].outcome === 'applied');
    t.check('writing channel 3 leaves channel 1 alone', before1 === after1 && after1 === 45, `${before1} -> ${after1}`);
    const enc = await conn.write('stream:302', { 'video.bitrate': 1024 });
    const other = await conn.read('stream:102', ['video.bitrate']);
    t.check('encoder write on channel 3 sub leaves channel 1 sub alone',
      enc.results['video.bitrate'].outcome === 'applied' && other.values['video.bitrate'] === 512);
  } finally {
    conn.close();
    await dev.close();
  }
}

t.section('refusals');
{
  const dev = await startPersona(camera, { mode: 'reject' });
  const conn = await adapter.connect(configFor(dev));
  try {
    const w = await conn.write('channel:1', { 'image.brightness': 70, 'image.dayNight': 'day' });
    t.check('<ResponseStatus> badParameters -> rejected for every field in that PUT',
      w.results['image.brightness'].outcome === 'rejected' && w.results['image.dayNight'].outcome === 'rejected', JSON.stringify(w.results));
    const e = await conn.write('stream:101', { 'video.gop': 25 });
    t.check('stream PUT refusal -> rejected', e.results['video.gop'].outcome === 'rejected');
  } finally {
    conn.close();
    await dev.close();
  }
}

t.section('probe isolation');
for (const name of ['axis-p3245', 'reolink-rlc810', 'uniview-ipc', 'dahua-ipc', 'lorex-n864']) {
  const file = new URL(`../personas/${name}.js`, import.meta.url);
  if (!existsSync(file)) { console.log(`  (persona ${name} not present — skipped)`); continue; }
  const { persona } = await import(file.href);
  const dev = await startPersona(persona);
  try {
    const p = await adapter.probe(configFor(dev));
    t.check(`hikvision probe does not claim ${name}`, p.match === false, JSON.stringify(p));
  } finally {
    await dev.close();
  }
}

t.done();
process.exit(t.failed ? 1 : 0);
