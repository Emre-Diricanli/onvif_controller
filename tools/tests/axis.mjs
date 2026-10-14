/**
 * Axis VAPIX adapter: conformance (ADAPTERS.md §8) plus adapter-specific
 * checks — encoder writes on the stream target, native<->canonical enum and
 * bool mapping, the per-field "rejected" outcome, and probe isolation
 * against the other vendors' personas.
 *
 * The reolink/uniview persona modules are written by other work streams; they
 * may not exist yet while this file is run on its own. The cross-vendor
 * checks therefore import them dynamically and skip (with a note) when the
 * module is absent — the full suite runs them once every persona exists.
 */
import { AppError } from '../../server/errors.js';
import { createChecker, runConformance, startPersona, startNotFoundServer, HARNESS_CREDENTIALS } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/axis/index.js';
import { persona } from '../personas/axis-p3245.js';

const t = createChecker('axis');

const configFor = (dev) => ({ host: dev.host, port: dev.port, ...HARNESS_CREDENTIALS, timeoutMs: 4000 });

async function expectAppError(promise, code) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err instanceof AppError && err.code === code ? err : null;
  }
}

// --- generic contract ---------------------------------------------------
await runConformance(t, { adapter, persona, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });

// --- encoder writes on the stream target --------------------------------
t.section('encoder writes on the stream target');
{
  const dev = await startPersona(persona);
  const conn = await adapter.connect(configFor(dev));
  try {
    const stream = (await conn.listTargets()).find((x) => x.scope === 'stream');
    t.check('has a stream target', Boolean(stream));
    const missing = await expectAppError(conn.read('no-such-target'), 'NOT_FOUND');
    t.check('read on unknown target -> NOT_FOUND', Boolean(missing));
    const w = await conn.write(stream.id, { 'video.bitrate': 4096, 'video.fps': 12 });
    t.check('video.bitrate applied', w.results['video.bitrate']?.outcome === 'applied', JSON.stringify(w.results));
    t.check('video.fps applied', w.results['video.fps']?.outcome === 'applied', JSON.stringify(w.results));
    const back = await conn.read(stream.id, ['video.bitrate', 'video.fps']);
    t.check('read-back shows the new encoder values',
      back.values['video.bitrate'] === 4096 && back.values['video.fps'] === 12,
      JSON.stringify(back.values));
  } finally {
    conn.close();
    await dev.close();
  }
}

// --- native <-> canonical enum and bool mapping --------------------------
t.section('enum and bool mapping');
{
  const dev = await startPersona(persona);
  const conn = await adapter.connect(configFor(dev));
  try {
    const target = (await conn.listTargets()).find((x) => x.scope === 'channel');
    const before = await conn.read(target.id, ['image.dayNight', 'image.wdr']);
    t.check('image.dayNight reads as auto', before.values['image.dayNight'] === 'auto', JSON.stringify(before.values));
    t.check('image.wdr reads as false', before.values['image.wdr'] === false, JSON.stringify(before.values));

    const w = await conn.write(target.id, { 'image.dayNight': 'night' });
    t.check('image.dayNight=night applied', w.results['image.dayNight']?.outcome === 'applied', JSON.stringify(w.results));
    const back = await conn.read(target.id, ['image.dayNight']);
    t.check('read-back reports night (persona stored native bw)', back.values['image.dayNight'] === 'night', JSON.stringify(back.values));

    const w2 = await conn.write(target.id, { 'image.wdr': true });
    t.check('image.wdr=true applied', w2.results['image.wdr']?.outcome === 'applied', JSON.stringify(w2.results));
    const back2 = await conn.read(target.id, ['image.wdr']);
    t.check('read-back reports wdr on (persona stored native "on")', back2.values['image.wdr'] === true, JSON.stringify(back2.values));
  } finally {
    conn.close();
    await dev.close();
  }
}

// --- per-field "rejected" outcome ----------------------------------------
t.section('rejected outcome');
{
  const dev = await startPersona(persona, { mode: 'reject' });
  const conn = await adapter.connect(configFor(dev));
  try {
    const target = (await conn.listTargets()).find((x) => x.scope === 'channel');
    const w = await conn.write(target.id, { 'image.brightness': 80 });
    t.check('persona refusal surfaces as rejected, not applied',
      w.results['image.brightness']?.outcome === 'rejected', JSON.stringify(w.results));
  } finally {
    conn.close();
    await dev.close();
  }
}

// --- cross-vendor probe isolation ----------------------------------------
// The Axis probe must identify by content, so it must not match a Reolink or
// Uniview persona that happens to share host credentials.
t.section('cross-vendor probe isolation');
{
  const nf = await startNotFoundServer();
  const p404 = await adapter.probe({ ...configFor({ host: nf.host, port: nf.port }) }).catch((err) => ({ threw: err }));
  t.check('probe does not match a plain 404 server', p404?.match === false, JSON.stringify(p404));
  await nf.close();

  for (const rel of ['../personas/reolink-rlc810.js', '../personas/uniview-ipc.js']) {
    const name = rel.split('/').pop();
    let other = null;
    try {
      other = (await import(new URL(rel, import.meta.url).href)).persona;
    } catch {
      console.log(`  skip  ${name} persona module not present yet`);
      continue;
    }
    const dev = await startPersona(other);
    try {
      const res = await adapter.probe(configFor(dev));
      t.check(`probe does not match ${name}`, res.match === false, JSON.stringify(res));
    } finally {
      await dev.close();
    }
  }
}

t.done();
