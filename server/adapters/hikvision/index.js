/**
 * Hikvision ISAPI adapter (ADAPTERS.md §5).
 *
 * ISAPI is Hikvision's own REST-ish XML API, over HTTP Digest. It is often
 * the better path than ONVIF on this hardware: NVRs ship with ONVIF disabled
 * (README "Hikvision notes"), ONVIF needs a separate user, and the ONVIF
 * imaging service on some firmware accepts writes it does not apply
 * (server/onvif/imaging.js). ISAPI is what Hikvision's own web UI drives.
 *
 * Shape of the API this adapter relies on:
 *   GET  /ISAPI/System/deviceInfo                     identity (probe)
 *   GET  /ISAPI/System/Video/inputs/channels          camera inputs
 *   GET  /ISAPI/ContentMgmt/InputProxy/channels       recorder (NVR) channels
 *   GET  /ISAPI/Streaming/channels                    streams 101, 102, 201, …
 *   GET  /ISAPI/Streaming/channels/<id>/capabilities  opt/min/max per element
 *   GET|PUT /ISAPI/Streaming/channels/<id>            encoder settings
 *   GET|PUT /ISAPI/Image/channels/<n>/<sub>           color, sharpness,
 *                                                     ircutFilter, WDR, BLC, imageFlip
 *
 * PUT replaces the whole node, so every write is GET → edit only the
 * requested elements in the device's own document → PUT it back, under the
 * per-resource lock, then verified by read-back. A refusal arrives as an XML
 * <ResponseStatus> with statusCode != 1 (usually HTTP 400, subStatusCode
 * badParameters / invalidContent) and maps to outcome "rejected".
 *
 * Verification: mock-verified (personas hikvision-ds2cd, hikvision-nvr).
 * Element names follow the published ISAPI schema; per-firmware variation is
 * real, so a sub-resource that 404s is simply not offered — assumed from
 * vendor docs, not hardware-verified.
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, verifyWrite } from '../../settings/contract.js';
import * as xml from './xml.js';

export const id = 'hikvision';
export const label = 'Hikvision ISAPI';
export const priority = 20;
export const defaultPorts = [80];

const XML_HEADERS = { 'Content-Type': 'application/xml; charset="UTF-8"' };
const bool = (v) => String(v).trim().toLowerCase() === 'true';
const int = (v) => (v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v)));

// ------------------------------------------------------------------ imaging

/** Image sub-resources, each its own GET/PUT document and its own lock. */
const IMAGE_RESOURCES = {
  color: { path: 'color', root: 'Color' },
  sharpness: { path: 'sharpness', root: 'Sharpness' },
  ircut: { path: 'ircutFilter', root: 'IrcutFilter' },
  wdr: { path: 'WDR', root: 'WDR' },
  blc: { path: 'BLC', root: 'BLC' },
  flip: { path: 'imageFlip', root: 'ImageFlip' },
};

/** Mirror and flip share one <ImageFlip> element: enabled + a single style. */
function readFlip(doc) {
  if (xml.text(doc, 'enabled') === null) return {};
  const on = bool(xml.text(doc, 'enabled'));
  const style = String(xml.text(doc, 'ImageFlipStyle') ?? '').toUpperCase();
  return {
    mirror: on && (style === 'LEFTRIGHT' || style === 'CENTER'),
    flip: on && (style === 'UPDOWN' || style === 'CENTER'),
  };
}

function writeFlip(doc, { mirror, flip }) {
  const style = mirror && flip ? 'CENTER' : mirror ? 'LEFTRIGHT' : flip ? 'UPDOWN' : null;
  let out = xml.setText(doc, 'enabled', style ? 'true' : 'false');
  if (out && style) out = xml.setText(out, 'ImageFlipStyle', style) ?? out;
  return out;
}

// Hikvision documents these levels as a fixed 0..100 (ADAPTERS.md §3 allows a
// vendor-documented fixed range).
const level = (key, labelText, resource, tag) => ({
  key, label: labelText, resource, type: 'int', min: 0, max: 100, step: 1,
  read: (doc) => int(xml.text(doc, tag)),
  write: (doc, value) => xml.setText(doc, tag, value),
});

const IMAGE_KEYS = [
  level('image.brightness', 'Brightness', 'color', 'brightnessLevel'),
  level('image.contrast', 'Contrast', 'color', 'contrastLevel'),
  level('image.saturation', 'Saturation', 'color', 'saturationLevel'),
  level('image.sharpness', 'Sharpness', 'sharpness', 'SharpnessLevel'),
  {
    key: 'image.dayNight', label: 'Day/night', resource: 'ircut', type: 'enum', values: ['auto', 'day', 'night'],
    read: (doc) => {
      const v = String(xml.text(doc, 'IrcutFilterType') ?? '').toLowerCase();
      return ['auto', 'day', 'night'].includes(v) ? v : undefined;
    },
    write: (doc, value) => xml.setText(doc, 'IrcutFilterType', value),
  },
  {
    // WDR mode is open | close | auto. "auto" means the device decides, which
    // is still WDR enabled; writing true selects "open".
    key: 'image.wdr', label: 'Wide dynamic range', resource: 'wdr', type: 'bool',
    read: (doc) => {
      const mode = xml.text(doc, 'mode');
      return mode === null ? undefined : mode.toLowerCase() !== 'close';
    },
    write: (doc, value) => xml.setText(doc, 'mode', value ? 'open' : 'close'),
  },
  level('image.wdrLevel', 'WDR level', 'wdr', 'WDRLevel'),
  {
    key: 'image.blc', label: 'Backlight compensation', resource: 'blc', type: 'bool',
    read: (doc) => (xml.text(doc, 'enabled') === null ? undefined : bool(xml.text(doc, 'enabled'))),
    write: (doc, value) => xml.setText(doc, 'enabled', value ? 'true' : 'false'),
  },
  {
    key: 'image.mirror', label: 'Mirror', resource: 'flip', type: 'bool',
    read: (doc) => readFlip(doc).mirror,
    write: (doc, value, desired) => writeFlip(doc, { ...desired, mirror: value }),
  },
  {
    key: 'image.flip', label: 'Flip', resource: 'flip', type: 'bool',
    read: (doc) => readFlip(doc).flip,
    write: (doc, value, desired) => writeFlip(doc, { ...desired, flip: value }),
  },
];

// ------------------------------------------------------------------ encoder

const CODECS = ['H.264', 'H.265', 'MJPEG'];
const STREAM_NAMES = { 1: 'Main stream', 2: 'Sub stream', 3: 'Third stream' };

function streamValues(doc) {
  const video = xml.block(doc, 'Video') ?? '';
  const out = {};
  const codec = xml.text(video, 'videoCodecType');
  if (codec && CODECS.includes(codec)) out['video.codec'] = codec;
  const w = int(xml.text(video, 'videoResolutionWidth'));
  const h = int(xml.text(video, 'videoResolutionHeight'));
  if (w && h) out['video.resolution'] = `${w}x${h}`;
  // maxFrameRate is in hundredths of a frame per second (2500 = 25 fps).
  const fps = xml.text(video, 'maxFrameRate');
  if (fps !== null) out['video.fps'] = Number(fps) / 100;
  const mode = String(xml.text(video, 'videoQualityControlType') ?? '').toLowerCase();
  if (mode === 'cbr' || mode === 'vbr') out['video.bitrateMode'] = mode;
  // In VBR the operator-facing number is the cap; in CBR it is the rate.
  const bitrate = mode === 'vbr' ? xml.text(video, 'vbrUpperCap') : xml.text(video, 'constantBitRate');
  if (bitrate !== null) out['video.bitrate'] = int(bitrate);
  const gop = xml.text(video, 'GovLength');
  if (gop !== null) out['video.gop'] = int(gop);
  return out;
}

function streamDescriptors(current, caps, resource) {
  const video = xml.block(caps ?? '', 'Video') ?? '';
  const opt = (tag) => (xml.attr(video, tag, 'opt') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const range = (tag) => {
    const min = xml.attr(video, tag, 'min');
    const max = xml.attr(video, tag, 'max');
    return min !== null && max !== null ? { min: Number(min), max: Number(max) } : null;
  };
  const base = { group: 'encoder', resource };
  const out = [];

  if ('video.codec' in current) {
    const values = opt('videoCodecType').filter((c) => CODECS.includes(c));
    out.push({ ...base, key: 'video.codec', label: 'Codec', type: 'enum', unit: null,
      values: values.length ? values : [current['video.codec']], writable: values.length > 0 });
  }
  if ('video.resolution' in current) {
    // Capabilities list widths and heights as two index-aligned opt lists.
    const widths = opt('videoResolutionWidth');
    const heights = opt('videoResolutionHeight');
    const values = widths.length && widths.length === heights.length
      ? widths.map((w, i) => `${w}x${heights[i]}`) : [];
    out.push({ ...base, key: 'video.resolution', label: 'Resolution', type: 'enum', unit: null,
      values: values.length ? values : [current['video.resolution']], writable: values.length > 0 });
  }
  if ('video.fps' in current) {
    const rates = opt('maxFrameRate').map(Number).filter((n) => Number.isFinite(n));
    const d = { ...base, key: 'video.fps', label: 'Frame rate', type: 'number', unit: 'fps', writable: rates.length > 0 };
    if (rates.length) Object.assign(d, { min: Math.min(...rates) / 100, max: Math.max(...rates) / 100 });
    out.push(d);
  }
  if ('video.bitrateMode' in current) {
    const values = opt('videoQualityControlType').map((m) => m.toLowerCase()).filter((m) => m === 'cbr' || m === 'vbr');
    out.push({ ...base, key: 'video.bitrateMode', label: 'Bitrate mode', type: 'enum', unit: null,
      values: values.length ? values : [current['video.bitrateMode']], writable: values.length > 0 });
  }
  if ('video.bitrate' in current) {
    const r = range('constantBitRate') ?? range('vbrUpperCap');
    out.push({ ...base, key: 'video.bitrate', label: 'Bitrate', type: 'int', unit: 'kbps', writable: Boolean(r), ...(r ? { ...r, step: 1 } : {}) });
  }
  if ('video.gop' in current) {
    const r = range('GovLength');
    out.push({ ...base, key: 'video.gop', label: 'I-frame interval', type: 'int', unit: null, writable: Boolean(r), ...(r ? { ...r, step: 1 } : {}) });
  }
  return out;
}

function applyStreamPatch(doc, patch, current) {
  let out = doc;
  const set = (tag, value) => {
    const next = xml.setText(out, tag, value, 'Video');
    if (next === null) throw new AppError('DEVICE_ERROR', `The device's stream document has no <${tag}> to change.`);
    out = next;
  };
  if ('video.codec' in patch) set('videoCodecType', patch['video.codec']);
  if ('video.resolution' in patch) {
    const [w, h] = patch['video.resolution'].split('x');
    set('videoResolutionWidth', w);
    set('videoResolutionHeight', h);
  }
  if ('video.fps' in patch) set('maxFrameRate', Math.round(patch['video.fps'] * 100));
  const mode = patch['video.bitrateMode'] ?? current['video.bitrateMode'];
  if ('video.bitrateMode' in patch) set('videoQualityControlType', patch['video.bitrateMode'].toUpperCase());
  if ('video.bitrate' in patch) set(mode === 'vbr' ? 'vbrUpperCap' : 'constantBitRate', patch['video.bitrate']);
  if ('video.gop' in patch) set('GovLength', patch['video.gop']);
  return out;
}

// ------------------------------------------------------------------ probe

function isDeviceInfo(body) {
  return /<DeviceInfo[\s>]/.test(body) && /hikvision\.com|isapi\.org/i.test(body);
}

/** Identify by the DeviceInfo document itself, never by a 200 alone. */
export async function probe(config) {
  const client = createHttpClient({ ...config, auth: 'auto', timeoutMs: config.timeoutMs ?? 3000 });
  try {
    const res = await client.request({ path: '/ISAPI/System/deviceInfo' });
    if (res.status !== 200 || !isDeviceInfo(res.text)) return { match: false, confidence: 0 };
    return {
      match: true,
      confidence: 0.95,
      model: xml.text(res.text, 'model'),
      firmware: xml.text(res.text, 'firmwareVersion'),
    };
  } catch {
    return { match: false, confidence: 0 };
  } finally {
    client.close();
  }
}

// ------------------------------------------------------------------ connection

export async function connect(config) {
  const client = createHttpClient({ ...config, auth: 'auto' });
  const lock = (resource, fn) => withResourceLock(lockKey(config.host, config.port, resource), fn);

  async function get(path, { optional = false } = {}) {
    const res = await client.request({ path });
    if (res.status === 200) return res.text;
    if (optional && (res.status === 404 || res.status === 403 || res.status === 400)) return null;
    throw new AppError('DEVICE_ERROR', `The device refused ${path.split('?')[0]} (HTTP ${res.status}).`);
  }

  async function put(path, body) {
    const res = await client.request({ method: 'PUT', path, headers: XML_HEADERS, body });
    const status = xml.responseStatus(res.text);
    const ok = res.status < 400 && (!status || status.code === 1);
    return { ok, status };
  }

  let info;
  try {
    info = await get('/ISAPI/System/deviceInfo');
  } catch (err) {
    client.close();
    throw err;
  }
  if (!isDeviceInfo(info)) {
    client.close();
    throw new AppError('DEVICE_ERROR', 'The device did not answer as Hikvision ISAPI.');
  }

  // --- targets, discovered once per connection ---
  let targetCache = null;
  async function targets() {
    if (targetCache) return targetCache;
    let channels = xml.blocks(await get('/ISAPI/System/Video/inputs/channels', { optional: true }), 'VideoInputChannel');
    if (channels.length === 0) {
      channels = xml.blocks(await get('/ISAPI/ContentMgmt/InputProxy/channels', { optional: true }), 'InputProxyChannel');
    }
    const list = [];
    const labels = new Map();
    for (const node of channels) {
      const n = int(xml.text(node, 'id'));
      if (!n) continue;
      const name = xml.text(node, 'name');
      const labelText = name && !/^camera\s*0*\d+$/i.test(name) ? name : `Channel ${n}`;
      labels.set(n, labelText);
      list.push({ id: `channel:${n}`, scope: 'channel', label: labelText, channel: n });
    }
    const streams = xml.blocks(await get('/ISAPI/Streaming/channels', { optional: true }), 'StreamingChannel');
    for (const node of streams) {
      const streamId = int(xml.text(node, 'id'));
      if (!streamId) continue;
      // Stream ids encode channel*100 + stream number (101 = channel 1 main).
      const n = int(xml.text(node, 'videoInputChannelID')) ?? Math.floor(streamId / 100);
      list.push({
        id: `stream:${streamId}`,
        scope: 'stream',
        label: `${labels.get(n) ?? `Channel ${n}`} · ${STREAM_NAMES[streamId % 100] ?? `Stream ${streamId % 100}`}`,
        channel: n,
        parent: labels.has(n) ? `channel:${n}` : undefined,
      });
    }
    targetCache = list;
    return list;
  }

  async function resolve(targetId) {
    const target = (await targets()).find((t) => t.id === targetId);
    if (!target) throw new AppError('NOT_FOUND', `This device has no target "${targetId}".`);
    return target;
  }

  // --- imaging ---
  const imagePath = (n, resource) => `/ISAPI/Image/channels/${n}/${IMAGE_RESOURCES[resource].path}`;

  async function imageDocs(n, resources) {
    const docs = {};
    for (const resource of resources) docs[resource] = await get(imagePath(n, resource), { optional: true });
    return docs;
  }

  function imageValues(docs, keys) {
    const values = {};
    for (const spec of IMAGE_KEYS) {
      if (keys && !keys.includes(spec.key)) continue;
      if (!docs[spec.resource]) continue;
      const v = spec.read(docs[spec.resource]);
      if (v !== undefined) values[spec.key] = v;
    }
    return values;
  }

  const describeCache = new Map();
  async function describe(target) {
    if (describeCache.has(target.id)) return describeCache.get(target.id);
    let descriptors;
    if (target.scope === 'channel') {
      const docs = await imageDocs(target.channel, Object.keys(IMAGE_RESOURCES));
      const values = imageValues(docs);
      descriptors = IMAGE_KEYS.filter((s) => s.key in values).map((s) => ({
        key: s.key, label: s.label, group: 'imaging', type: s.type, unit: null,
        ...(s.min !== undefined ? { min: s.min, max: s.max, step: s.step } : {}),
        ...(s.values ? { values: s.values } : {}),
        writable: true,
        resource: `image/${target.channel}/${s.resource}`,
      }));
    } else {
      const sid = target.id.slice('stream:'.length);
      const current = streamValues(await get(`/ISAPI/Streaming/channels/${sid}`));
      const caps = await get(`/ISAPI/Streaming/channels/${sid}/capabilities`, { optional: true });
      descriptors = streamDescriptors(current, caps, `stream/${sid}`);
    }
    describeCache.set(target.id, descriptors);
    return descriptors;
  }

  async function readTarget(target, keys) {
    if (target.scope === 'channel') {
      const resources = [...new Set(IMAGE_KEYS.filter((s) => !keys || keys.includes(s.key)).map((s) => s.resource))];
      return imageValues(await imageDocs(target.channel, resources), keys);
    }
    const values = streamValues(await get(`/ISAPI/Streaming/channels/${target.id.slice('stream:'.length)}`));
    return keys ? Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])) : values;
  }

  /** Take several resource locks in a fixed order, so two writers cannot deadlock. */
  function withLocks(resources, fn) {
    const sorted = [...resources].sort();
    const step = (i) => (i === sorted.length ? fn() : lock(sorted[i], () => step(i + 1)));
    return step(0);
  }

  async function writeImaging(target, patch, used) {
    const byResource = new Map();
    for (const key of Object.keys(patch)) {
      const spec = IMAGE_KEYS.find((s) => s.key === key);
      if (!byResource.has(spec.resource)) byResource.set(spec.resource, []);
      byResource.get(spec.resource).push(spec);
    }
    const lockNames = [...byResource.keys()].map((r) => `image/${target.channel}/${r}`);
    return withLocks(lockNames, async () => {
      const before = {};
      const rejected = [];
      for (const [resource, specs] of byResource) {
        let doc = await get(imagePath(target.channel, resource));
        const current = imageValues({ [resource]: doc });
        Object.assign(before, Object.fromEntries(specs.map((s) => [s.key, current[s.key]])));
        // Mirror and flip edit one element together; each sees the other's
        // desired value, not just its own.
        const desired = {
          mirror: patch['image.mirror'] ?? current['image.mirror'],
          flip: patch['image.flip'] ?? current['image.flip'],
        };
        for (const spec of specs) {
          const next = spec.write(doc, patch[spec.key], desired);
          if (next === null) throw new AppError('DEVICE_ERROR', `The device's ${resource} document is missing the element for ${spec.key}.`);
          doc = next;
        }
        const { ok } = await put(imagePath(target.channel, resource), doc);
        if (!ok) rejected.push(...specs.map((s) => s.key));
      }
      return verifyWrite({
        patch, before, descriptors: used, rejected, source: id,
        readBack: () => readTarget(target, Object.keys(patch)),
      });
    });
  }

  async function writeStream(target, patch, used) {
    const sid = target.id.slice('stream:'.length);
    return withLocks([`stream/${sid}`], async () => {
      const path = `/ISAPI/Streaming/channels/${sid}`;
      const doc = await get(path);
      const current = streamValues(doc);
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k]]));
      const { ok } = await put(path, applyStreamPatch(doc, patch, current));
      return verifyWrite({
        patch, before, descriptors: used, rejected: ok ? [] : Object.keys(patch), source: id,
        readBack: () => readTarget(target, Object.keys(patch)),
      });
    });
  }

  return {
    id,
    label,
    info: {
      vendor: 'Hikvision',
      model: xml.text(info, 'model'),
      firmware: xml.text(info, 'firmwareVersion'),
      serial: xml.text(info, 'serialNumber'),
    },
    async listTargets() {
      return targets();
    },
    async describeSettings(targetId) {
      return describe(await resolve(targetId));
    },
    async read(targetId, keys) {
      return { values: await readTarget(await resolve(targetId), keys), source: id };
    },
    async write(targetId, patch) {
      const target = await resolve(targetId);
      const used = validatePatch(patch, await describe(target));
      return target.scope === 'channel' ? writeImaging(target, patch, used) : writeStream(target, patch, used);
    },
    close() {
      client.close();
    },
  };
}
