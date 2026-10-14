/**
 * Uniview LAPI adapter checks (ADAPTERS.md §8).
 *
 * Beyond the generic conformance pass: encoder read-modify-write on a stream
 * target, LAPI's HTTP-200-with-ResponseCode!=0 refusal surfacing as
 * 'rejected', enum mappings both ways, and probe isolation against the other
 * vendors' personas.
 */
import { createChecker, runConformance, startPersona } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/uniview/index.js';
import { persona } from '../personas/uniview-ipc.js';
import { persona as axisPersona } from '../personas/axis-p3245.js';
import { persona as reolinkPersona } from '../personas/reolink-rlc810.js';

const t = createChecker('uniview');
const CONFIG = { username: 'admin', password: 'Harness-Pass1', timeoutMs: 4000 };

// The generic contract, using image.brightness (persona default 50).
await runConformance(t, { adapter, persona, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });

t.section('encoder write on a stream target');

{
  const dev = await startPersona(persona);
  let conn = null;
  try {
    conn = await adapter.connect({ host: dev.host, port: dev.port, ...CONFIG });
    const major = (await conn.listTargets()).find((x) => x.id === 'stream:1.major');
    t.check('stream:1.major target exists', Boolean(major), JSON.stringify(await conn.listTargets()));

    const w = await conn.write(major.id, { 'video.bitrate': 8192, 'video.fps': 12 });
    t.check('video.bitrate is applied', w?.results?.['video.bitrate']?.outcome === 'applied', JSON.stringify(w?.results));
    t.check('video.fps is applied', w?.results?.['video.fps']?.outcome === 'applied', JSON.stringify(w?.results));
    t.check('write result has source uniview', w?.source === 'uniview');

    const read = await conn.read(major.id);
    t.check('read-back has bitrate 8192', read.values?.['video.bitrate'] === 8192, JSON.stringify(read.values));
    t.check('read-back has fps 12', read.values?.['video.fps'] === 12, JSON.stringify(read.values));
    // Enum/string mappings on the way out: native '*' -> canonical 'x', CBR -> cbr.
    t.check('read-back maps codec enum', read.values?.['video.codec'] === 'H.264', JSON.stringify(read.values));
    t.check('read-back maps bitrateMode enum', read.values?.['video.bitrateMode'] === 'cbr', JSON.stringify(read.values));
    t.check('read-back maps resolution to WxH', read.values?.['video.resolution'] === '1920x1080', JSON.stringify(read.values));

    // The minor stream must be untouched by the major-stream write: the PUT
    // sent the whole array back, unchanged except the requested stream.
    const minor = await conn.read('stream:1.minor');
    t.check('minor stream untouched by major write', minor.values?.['video.bitrate'] === 512 && minor.values?.['video.fps'] === 15,
      JSON.stringify(minor.values));
  } finally {
    try { conn?.close(); } catch { /* close must not throw */ }
    await dev.close();
  }
}

t.section('rejected outcome (LAPI ResponseCode != 0 on HTTP 200)');

{
  const dev = await startPersona(persona, { mode: 'reject' });
  let conn = null;
  try {
    conn = await adapter.connect({ host: dev.host, port: dev.port, ...CONFIG });
    const w = await conn.write('channel:1', { 'image.brightness': 80 });
    t.check('refused field reports rejected, not applied or thrown',
      w?.results?.['image.brightness']?.outcome === 'rejected', JSON.stringify(w?.results));
  } finally {
    try { conn?.close(); } catch { /* close must not throw */ }
    await dev.close();
  }
}

t.section('enum mappings on write');

{
  const dev = await startPersona(persona);
  let conn = null;
  try {
    conn = await adapter.connect({ host: dev.host, port: dev.port, ...CONFIG });
    const day = await conn.write('channel:1', { 'image.dayNight': 'night' });
    t.check('image.dayNight=night applied', day?.results?.['image.dayNight']?.outcome === 'applied', JSON.stringify(day?.results));
    const dayRead = await conn.read('channel:1', ['image.dayNight']);
    t.check('dayNight read back as night', dayRead.values?.['image.dayNight'] === 'night', JSON.stringify(dayRead.values));

    const mode = await conn.write('stream:1.major', { 'video.bitrateMode': 'vbr' });
    t.check('video.bitrateMode=vbr applied', mode?.results?.['video.bitrateMode']?.outcome === 'applied', JSON.stringify(mode?.results));
    const modeRead = await conn.read('stream:1.major', ['video.bitrateMode']);
    t.check('bitrateMode read back as vbr', modeRead.values?.['video.bitrateMode'] === 'vbr', JSON.stringify(modeRead.values));
  } finally {
    try { conn?.close(); } catch { /* close must not throw */ }
    await dev.close();
  }
}

t.section('cross-vendor probe isolation');

for (const other of [
  { persona: axisPersona, name: 'axis-p3245' },
  { persona: reolinkPersona, name: 'reolink-rlc810' },
]) {
  const dev = await startPersona(other.persona);
  try {
    const probed = await adapter.probe({ host: dev.host, port: dev.port, ...CONFIG }).catch((err) => ({ threw: err }));
    t.check(`probe does not match ${other.name}`, probed?.match === false && !probed?.threw, JSON.stringify(probed));
  } finally {
    await dev.close();
  }
}

t.done();
