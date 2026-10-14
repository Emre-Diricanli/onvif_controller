/**
 * Live-relay tests: server/stream/fmp4.js (keyframe detection in fragmented
 * MP4) and server/stream/ws.js (handleStreamSocket).
 *
 * tools/fake-ffmpeg.mjs shells out to a real ffmpeg binary, so these tests
 * hand-assemble minimal moof/traf/tfhd/trun/mdat boxes instead — deterministic,
 * portable, and able to cover flag sources (trun first_sample_flags, trun
 * per-sample flags, tfhd default_sample_flags) a real encoder would never
 * produce on demand. The relay itself is driven through a fake WebSocket and a
 * fake pipeline handle (EventEmitter + addViewer/removeViewer), which is the
 * exact contract ws.js codes against.
 *
 * Plain node, no ports: `node tools/tests/ws.mjs`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isKeyframeFragment } from '../../server/stream/fmp4.js';
import { handleStreamSocket } from '../../server/stream/ws.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}:`, err); }
}

// ---------------------------------------------------------------- box builder

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
}

function u64(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
}

function box(type, ...payload) {
  const parts = payload.map((p) => (Buffer.isBuffer(p) ? p : u32(p)));
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body]);
}

function fullbox(type, version, flags, ...payload) {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...payload);
}

/** tfhd with only the optional fields that were provided; flags derived. */
function tfhdBox({
  trackId = 1, baseDataOffset = null, sampleDescriptionIndex = null,
  defaultSampleDuration = null, defaultSampleSize = null, defaultSampleFlags = null,
} = {}) {
  let flags = 0x020000; // default-base-is-moof, as the pipeline's movflags produce
  const payload = [u32(trackId)];
  if (baseDataOffset !== null) { flags |= 0x000001; payload.push(u64(baseDataOffset)); }
  if (sampleDescriptionIndex !== null) { flags |= 0x000002; payload.push(u32(sampleDescriptionIndex)); }
  if (defaultSampleDuration !== null) { flags |= 0x000008; payload.push(u32(defaultSampleDuration)); }
  if (defaultSampleSize !== null) { flags |= 0x000010; payload.push(u32(defaultSampleSize)); }
  if (defaultSampleFlags !== null) { flags |= 0x000020; payload.push(u32(defaultSampleFlags)); }
  return fullbox('tfhd', 0, flags, ...payload);
}

/** trun; per-sample record fields derived from which arrays were provided. */
function trunBox({
  sampleCount = 2, dataOffset = null, firstSampleFlags = null,
  sampleDurations = null, sampleSizes = null, sampleFlags = null,
} = {}) {
  let flags = 0;
  const payload = [u32(sampleCount)];
  if (dataOffset !== null) { flags |= 0x000001; payload.push(u32(dataOffset)); }
  if (firstSampleFlags !== null) { flags |= 0x000004; payload.push(u32(firstSampleFlags)); }
  if (sampleDurations) flags |= 0x000100;
  if (sampleSizes) flags |= 0x000200;
  if (sampleFlags) flags |= 0x000400;
  for (let i = 0; i < sampleCount; i++) {
    if (sampleDurations) payload.push(u32(sampleDurations[i] ?? 0));
    if (sampleSizes) payload.push(u32(sampleSizes[i] ?? 0));
    if (sampleFlags) payload.push(u32(sampleFlags[i] ?? 0));
  }
  return fullbox('trun', 0, flags, ...payload);
}

/** A whole moof+mdat fragment, the shape pipeline.js emits per 'fragment'. */
function fragment(trafBoxes, payload = 'media') {
  return Buffer.concat([
    box('moof', fullbox('mfhd', 0, 0, u32(1)), ...trafBoxes),
    box('mdat', Buffer.from(payload)),
  ]);
}

function trafBox(tfhd, trun) {
  return box('traf', tfhd ?? tfhdBox({}), trun ?? trunBox({ dataOffset: 0, sampleSizes: [4, 4] }));
}

// Real ffmpeg sample-flags words: depends_on in bits 25-24, non_sync in bit 16.
const KEY = 0x02000000;    // I-picture, sync sample
const NONKEY = 0x01010000; // depends on others, non-sync

const keyFrag = (tag = 'k') => fragment([trafBox(tfhdBox({}), trunBox({ dataOffset: 0, firstSampleFlags: KEY, sampleSizes: [8, 8] }))], tag);
const nonKeyFrag = (tag = 'p') => fragment([trafBox(tfhdBox({}), trunBox({ dataOffset: 0, firstSampleFlags: NONKEY, sampleSizes: [8, 8] }))], tag);
const INIT = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.alloc(16))]);

// ------------------------------------------------------- isKeyframeFragment

console.log('\nfmp4: isKeyframeFragment');

await test('trun first_sample_flags decides (keyframe and not)', () => {
  assert.equal(isKeyframeFragment(keyFrag()), true);
  assert.equal(isKeyframeFragment(nonKeyFrag()), false);
});

await test('trun per-sample flags decide when first_sample_flags is absent', () => {
  const mk = (flags) => fragment([trafBox(tfhdBox({}),
    trunBox({ dataOffset: 0, sampleSizes: [8, 8], sampleFlags: flags }))]);
  assert.equal(isKeyframeFragment(mk([KEY, NONKEY])), true, 'sample 0 is the sync sample');
  assert.equal(isKeyframeFragment(mk([NONKEY, KEY])), false, 'a later keyframe does not make the fragment start one');
});

await test('tfhd default_sample_flags decide when the trun carries no flags', () => {
  const mk = (def) => fragment([trafBox(
    tfhdBox({ sampleDescriptionIndex: 1, defaultSampleDuration: 3000, defaultSampleSize: 8, defaultSampleFlags: def }),
    trunBox({ dataOffset: 0 }))]);
  assert.equal(isKeyframeFragment(mk(KEY)), true);
  assert.equal(isKeyframeFragment(mk(NONKEY)), false);
});

await test('precedence: trun first_sample_flags > per-sample > tfhd default', () => {
  const both = fragment([trafBox(
    tfhdBox({ defaultSampleFlags: KEY }),
    trunBox({ dataOffset: 0, firstSampleFlags: NONKEY, sampleSizes: [8], sampleFlags: [KEY], sampleCount: 1 }))]);
  assert.equal(isKeyframeFragment(both), false, 'first_sample_flags overrides everything for sample 0');

  const perVsDefault = fragment([trafBox(
    tfhdBox({ defaultSampleFlags: KEY }),
    trunBox({ dataOffset: 0, sampleSizes: [8, 8], sampleFlags: [NONKEY, KEY] }))]);
  assert.equal(isKeyframeFragment(perVsDefault), false, 'per-sample flags beat the tfhd default');

  const firstVsDefault = fragment([trafBox(
    tfhdBox({ defaultSampleFlags: NONKEY }),
    trunBox({ dataOffset: 0, firstSampleFlags: KEY, sampleSizes: [8, 8] }))]);
  assert.equal(isKeyframeFragment(firstVsDefault), true, 'trun beats tfhd');
});

await test('flags word semantics: depends_on==2 or non_sync==0 means keyframe', () => {
  const one = (flags) => fragment([trafBox(tfhdBox({}), trunBox({ dataOffset: 0, firstSampleFlags: flags, sampleCount: 1, sampleSizes: [8] }))]);
  assert.equal(isKeyframeFragment(one(0x02010000)), true, 'depends_on=2 wins even with non_sync=1');
  assert.equal(isKeyframeFragment(one(0x01000000)), true, 'non_sync=0 is a sync sample even when depends_on=1');
  assert.equal(isKeyframeFragment(one(0x00000000)), true, 'non_sync=0, depends_on undetermined');
  assert.equal(isKeyframeFragment(one(0x00010000)), false, 'non_sync=1, depends_on undetermined');
  assert.equal(isKeyframeFragment(one(KEY)), true);
});

await test('no moof anywhere -> false (init segments, garbage, empties)', () => {
  assert.equal(isKeyframeFragment(INIT), false, 'an init segment is not a keyframe fragment');
  assert.equal(isKeyframeFragment(Buffer.alloc(0)), false);
  assert.equal(isKeyframeFragment(Buffer.from('not an mp4 box at all')), false);
  assert.equal(isKeyframeFragment(undefined), false);
  assert.equal(isKeyframeFragment(null), false);
});

await test('moof present but no sample flags anywhere -> true (fail open)', () => {
  // ffmpeg always writes flags; an unflagged muxer is beyond reasoning about,
  // and in skip mode "cannot prove non-keyframe" must not freeze the viewer.
  const noFlags = fragment([trafBox(tfhdBox({}), trunBox({ dataOffset: 0, sampleSizes: [8, 8] }))]);
  assert.equal(isKeyframeFragment(noFlags), true);
  const noTraf = Buffer.concat([box('moof', fullbox('mfhd', 0, 0, u32(1))), box('mdat', Buffer.from('x'))]);
  assert.equal(isKeyframeFragment(noTraf), true);
});

await test('multiple trafs: the first determinable one decides', () => {
  const videoNonKeyAudioKey = fragment([
    trafBox(tfhdBox({ trackId: 1 }), trunBox({ dataOffset: 0, firstSampleFlags: NONKEY, sampleSizes: [8, 8] })),
    trafBox(tfhdBox({ trackId: 2 }), trunBox({ dataOffset: 0, firstSampleFlags: KEY, sampleSizes: [8, 8] })),
  ]);
  assert.equal(isKeyframeFragment(videoNonKeyAudioKey), false, 'an all-sync audio traf must not mask a non-key video traf');

  const videoUndeterminableAudioKey = fragment([
    trafBox(tfhdBox({ trackId: 1 }), trunBox({ dataOffset: 0, sampleSizes: [8, 8] })),
    trafBox(tfhdBox({ trackId: 2 }), trunBox({ dataOffset: 0, firstSampleFlags: KEY, sampleSizes: [8, 8] })),
  ]);
  assert.equal(isKeyframeFragment(videoUndeterminableAudioKey), true);
});

await test('moof is found at any top-level offset (styp prefix) and with 64-bit largesize', () => {
  const inner = box('moof', fullbox('mfhd', 0, 0, u32(1)),
    trafBox(tfhdBox({}), trunBox({ dataOffset: 0, firstSampleFlags: KEY, sampleSizes: [8, 8] })));
  const styp = box('styp', Buffer.from('msdh'));
  assert.equal(isKeyframeFragment(Buffer.concat([styp, inner, box('mdat', Buffer.from('m'))])), true);

  // Rewrite the moof header as size=1 + 64-bit largesize.
  const large = Buffer.concat([u32(1), Buffer.from('moof'), u64(inner.length), inner.subarray(8)]);
  assert.equal(isKeyframeFragment(Buffer.concat([large, box('mdat', Buffer.from('m'))])), true);
});

await test('truncated input never throws: cut mdat is fine, cut moof is false', () => {
  const frag = keyFrag();
  assert.equal(isKeyframeFragment(frag.subarray(0, frag.length - 4)), true, 'a clipped mdat leaves the moof intact');
  assert.equal(isKeyframeFragment(frag.subarray(0, 20)), false, 'the moof size exceeds the buffer');
  assert.equal(isKeyframeFragment(frag.subarray(0, 12)), false);
});

// ------------------------------------------------------------ handleStreamSocket

class FakeSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
    this.hooks = {};
  }
  send(data, opts) { this.sent.push({ binary: Boolean(opts?.binary), data }); }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    for (const fn of this.hooks.close ?? []) fn();
  }
  once(event, fn) { (this.hooks[event] ??= []).push(fn); }
  get binaries() { return this.sent.filter((m) => m.binary).map((m) => m.data); }
  get texts() { return this.sent.filter((m) => !m.binary).map((m) => JSON.parse(String(m.data))); }
}

function makeHandle({ initSegment = INIT, mime = 'video/mp4; codecs="avc1.42E01E"', gopCache, sessionId = 'sess-1' } = {}) {
  const handle = new EventEmitter();
  Object.assign(handle, { sessionId, mime, initSegment, viewers: 0, stopped: false, sessionEnded: false });
  if (gopCache !== undefined) handle.gopCache = gopCache;
  handle.addViewer = () => { if (handle.stopped) return false; handle.viewers += 1; return true; };
  handle.removeViewer = () => { handle.viewers -= 1; };
  return handle;
}

function open({ handle, session = { touch() {} }, params = 'session=sess-1&stream=st-1' } = {}) {
  const ws = new FakeSocket();
  const ctx = {
    getSession: (id) => (id === 'sess-1' ? session : undefined),
    pipeline: { getStream: (id) => (id === 'st-1' ? handle : undefined) },
  };
  handleStreamSocket(ws, new URL(`ws://127.0.0.1/ws/stream?${params}`), ctx);
  return ws;
}

const LAST_STATS = (ws) => ws.texts.filter((m) => m.type === 'stats').at(-1);

console.log('\nws: rejection paths');

await test('unknown session closes 4001, unknown stream closes 4002', () => {
  const noSession = open({ handle: makeHandle(), params: 'session=nope&stream=st-1' });
  assert.deepEqual(noSession.closed, { code: 4001, reason: 'Session expired' });
  assert.equal(noSession.sent.length, 0);

  const noStream = open({ handle: makeHandle(), params: 'session=sess-1&stream=nope' });
  assert.deepEqual(noStream.closed, { code: 4002, reason: 'Stream stopped' });

  const foreign = makeHandle({ sessionId: 'other-session' });
  const mismatch = open({ handle: foreign });
  assert.deepEqual(mismatch.closed, { code: 4002, reason: 'Stream stopped' });
  assert.equal(foreign.viewers, 0, 'a mismatched session must not even add a viewer');
});

await test('a stopped stream (addViewer false) closes 4002', () => {
  const handle = makeHandle();
  handle.stopped = true;
  const ws = open({ handle });
  assert.deepEqual(ws.closed, { code: 4002, reason: 'Stream stopped' });
  assert.equal(handle.viewers, 0);
});

console.log('\nws: handshake and late joiners');

await test('ready JSON first, then the stored init segment', () => {
  const handle = makeHandle();
  const ws = open({ handle });
  assert.equal(handle.viewers, 1);
  assert.deepEqual(ws.texts[0], { type: 'ready', mime: handle.mime });
  assert.equal(ws.binaries.length, 1);
  assert.equal(ws.binaries[0], INIT);
});

await test('a late joiner skips mid-GOP fragments until the first keyframe', () => {
  const handle = makeHandle(); // no gopCache in this branch's pipeline
  const ws = open({ handle });
  const p1 = nonKeyFrag('p1');
  const p2 = nonKeyFrag('p2');
  const k1 = keyFrag('k1');
  const p3 = nonKeyFrag('p3');
  handle.emit('fragment', p1);
  handle.emit('fragment', p2);
  handle.emit('fragment', k1);
  handle.emit('fragment', p3); // after the keyframe the GOP flows normally
  assert.deepEqual(ws.binaries, [INIT, k1, p3]);
  handle.emit('stats', { bitrateKbps: 6000, fps: 15, droppedFrames: 0 });
  assert.equal(LAST_STATS(ws).droppedFrames, 2, 'each skipped fragment counts once');
  assert.equal(LAST_STATS(ws).bitrateKbps, 6000, 'pipeline stats pass through unchanged');
});

console.log('\nws: backpressure skips to the next keyframe, never mid-GOP');

await test('over the threshold: drop until a keyframe, then resume; re-enter on new pressure', () => {
  const gk = keyFrag('gk');
  const handle = makeHandle({ gopCache: [gk] }); // primed, so skipping starts false
  const ws = open({ handle });
  const p0 = nonKeyFrag('p0');
  handle.emit('fragment', p0); // healthy socket: everything flows
  assert.deepEqual(ws.binaries, [INIT, gk, p0]);

  ws.bufferedAmount = 1024 * 1024; // exactly at the threshold: NOT over it
  const pAt = nonKeyFrag('pAt');
  handle.emit('fragment', pAt);
  assert.ok(ws.binaries.includes(pAt), 'bufferedAmount == threshold must not drop');

  ws.bufferedAmount = 1024 * 1024 + 1;
  const p1 = nonKeyFrag('p1');
  const p2 = nonKeyFrag('p2');
  const k1 = keyFrag('k1');
  const p3 = nonKeyFrag('p3');
  handle.emit('fragment', p1); // pressure: enter skipping
  handle.emit('fragment', p2); // still mid-GOP: dropped
  handle.emit('fragment', k1); // keyframe: resume AND send
  handle.emit('fragment', p3); // pressure persists: skip again immediately
  assert.equal(ws.binaries.includes(p1), false);
  assert.equal(ws.binaries.includes(p2), false);
  assert.ok(ws.binaries.includes(k1), 'the keyframe itself always goes out — it is the resume point');
  assert.equal(ws.binaries.includes(p3), false);

  ws.bufferedAmount = 0; // drained — but resuming mid-GOP would corrupt, so
  const p4 = nonKeyFrag('p4'); // skipping continues until the next keyframe
  const k2 = keyFrag('k2');
  const p5 = nonKeyFrag('p5');
  handle.emit('fragment', p4);
  handle.emit('fragment', k2);
  handle.emit('fragment', p5);
  assert.equal(ws.binaries.includes(p4), false);
  assert.ok(ws.binaries.includes(k2));
  assert.ok(ws.binaries.includes(p5), 'after the keyframe the stream is smooth again');

  handle.emit('stats', { bitrateKbps: 100, fps: 10, droppedFrames: 0 });
  assert.equal(LAST_STATS(ws).droppedFrames, 4, 'p1 p2 p3 p4');
});

console.log('\nws: gopCache priming');

await test('a keyframe-starting gopCache is sent right after init and resumes immediately', () => {
  const gk = keyFrag('gk');
  const gp = nonKeyFrag('gp');
  const handle = makeHandle({ gopCache: [gk, gp] });
  const ws = open({ handle });
  assert.deepEqual(ws.binaries, [INIT, gk, gp], 'cache goes out in order, right after the init segment');
  const live = nonKeyFrag('live');
  handle.emit('fragment', live);
  assert.ok(ws.binaries.includes(live), 'the cache ends mid-GOP, so the live continuation must flow');
});

await test('unusable gopCache shapes fall back to waiting for a live keyframe', () => {
  for (const gopCache of [[], [nonKeyFrag('bad')], null, 'nope', [INIT]]) {
    const handle = makeHandle({ gopCache });
    const ws = open({ handle });
    const p = nonKeyFrag('p');
    const k = keyFrag('k');
    handle.emit('fragment', p);
    handle.emit('fragment', k);
    assert.deepEqual(ws.binaries, [INIT, k], `gopCache ${JSON.stringify(gopCache)?.slice(0, 30)} must not prime`);
  }
  const absent = makeHandle();
  assert.equal('gopCache' in absent, false, 'the property is optional in this branch');
});

await test('no init segment yet: nothing is sent on connect, not even a valid cache', () => {
  const handle = makeHandle({ initSegment: null, gopCache: [keyFrag('gk')] });
  const ws = open({ handle });
  assert.equal(ws.binaries.length, 0, 'fragments without an init segment are undecodable');
  assert.deepEqual(ws.texts[0], { type: 'ready', mime: handle.mime });
  const init2 = Buffer.concat([INIT, Buffer.from('2')]);
  handle.emit('init', init2);
  const p = nonKeyFrag('p');
  const k = keyFrag('k');
  handle.emit('fragment', p);
  handle.emit('fragment', k);
  assert.deepEqual(ws.binaries, [init2, k], 'after a fresh init the stale cache is NOT replayed');
});

console.log('\nws: lifecycle');

await test('a mid-session init event re-gates until the next keyframe', () => {
  const handle = makeHandle({ gopCache: [keyFrag('gk')] }); // primed: skipping false
  const ws = open({ handle });
  const init2 = Buffer.concat([INIT, Buffer.from('restart')]);
  handle.emit('init', init2);
  assert.ok(ws.binaries.includes(init2));
  const p = nonKeyFrag('p');
  const k = keyFrag('k');
  handle.emit('fragment', p);
  handle.emit('fragment', k);
  assert.equal(ws.binaries.includes(p), false, 'the pre-restart GOP is undecodable after a new init');
  assert.ok(ws.binaries.includes(k));
});

await test('socket close releases the viewer and detaches every listener', () => {
  const handle = makeHandle();
  const ws = open({ handle });
  assert.equal(handle.viewers, 1);
  ws.close(1000, 'client gone'); // fires the once('close') hook like the real ws
  assert.equal(handle.viewers, 0);
  for (const event of ['init', 'fragment', 'stats', 'degraded', 'error', 'reconfigured', 'close']) {
    assert.equal(handle.listenerCount(event), 0, `listener for '${event}' leaked`);
  }
  const before = ws.sent.length;
  handle.emit('fragment', keyFrag('after-close'));
  handle.emit('stats', { bitrateKbps: 1, fps: 1, droppedFrames: 0 });
  assert.equal(ws.sent.length, before, 'a released socket must not be written to');
});

await test('a repeated close does not double-release', () => {
  const handle = makeHandle();
  const ws = open({ handle });
  ws.close(1000, 'gone');
  ws.hooks.error?.forEach((fn) => fn(new Error('late error')));
  assert.equal(handle.viewers, 0, 'removeViewer ran exactly once');
});

await test('stream stop closes viewers with 4002, session teardown with 4001', () => {
  const stopped = makeHandle();
  const ws1 = open({ handle: stopped });
  stopped.emit('close');
  assert.deepEqual(ws1.closed, { code: 4002, reason: 'Stream stopped' });

  const ended = makeHandle();
  ended.sessionEnded = true;
  const ws2 = open({ handle: ended });
  ended.emit('close');
  assert.deepEqual(ws2.closed, { code: 4001, reason: 'Session expired' });
});

await test('control frames pass through with their protocol shape', () => {
  const handle = makeHandle();
  const ws = open({ handle });
  handle.emit('degraded', { reason: 'ffmpeg exited 3 times', fallback: 'snapshot' });
  handle.emit('error', { code: 'STREAM_FAILED', message: 'The video stream stopped unexpectedly; retrying.' });
  handle.emit('reconfigured', { reason: 'encoder-changed', profile: 'mainStream' });
  const [degraded, error, reconfigured] = ws.texts.slice(1);
  assert.deepEqual(degraded, { type: 'degraded', reason: 'ffmpeg exited 3 times', fallback: 'snapshot' });
  assert.deepEqual(error, { type: 'error', code: 'STREAM_FAILED', message: 'The video stream stopped unexpectedly; retrying.' });
  assert.deepEqual(reconfigured, { type: 'reconfigured', reason: 'encoder-changed', profile: 'mainStream' });
});

await test('a non-open socket is never written to', () => {
  const handle = makeHandle();
  const ws = open({ handle });
  ws.readyState = 2; // CLOSING
  const before = ws.sent.length;
  handle.emit('fragment', keyFrag('k'));
  handle.emit('stats', { bitrateKbps: 1, fps: 1, droppedFrames: 0 });
  handle.emit('degraded', { reason: 'x', fallback: 'snapshot' });
  assert.equal(ws.sent.length, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
