/**
 * ONVIF as one adapter among several (ADAPTERS.md §5).
 *
 * This wraps the existing, hardware-hardened ONVIF modules rather than
 * reimplementing them: server/onvif/imaging.js and encoder.js already carry
 * the hand-built SOAP, the source-token validation and the read-back polling
 * that real Hikvision and Vatilon firmware forced on us. The adapter only
 * translates between their shapes and the canonical keys, and classifies the
 * outcome per field.
 *
 * Targets:
 *   source:<videoSourceToken>   imaging (one per physical input)
 *   stream:<profileToken>       encoder (one per media profile)
 *
 * Verification: device-verified for imaging/encoder via the existing ONVIF
 * paths (Hikvision, Vatilon, Dahua XVR); the adapter mapping is mock-verified
 * (tools/mock-camera.js).
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, classify } from '../../settings/contract.js';
import { connectDevice } from '../../onvif/connect.js';
import { readImaging, writeImaging } from '../../onvif/imaging.js';
import { readEncoder, writeEncoder } from '../../onvif/encoder.js';
import { config } from '../../config.js';

export const id = 'onvif';
export const label = 'ONVIF';
export const priority = 100;
export const defaultPorts = [80];

const PROBE_BODY = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
  + '<s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>';

/**
 * GetSystemDateAndTime is the one call ONVIF requires devices to answer
 * unauthenticated (it is how clients measure skew before signing). Some
 * firmware demands auth anyway; a SOAP fault from the device service still
 * identifies an ONVIF endpoint.
 */
export async function probe(cfg) {
  const client = createHttpClient({ ...cfg, auth: 'none', timeoutMs: cfg.timeoutMs ?? 4000 });
  try {
    const res = await client.request({
      method: 'POST',
      path: '/onvif/device_service',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: PROBE_BODY,
    });
    const text = res.text ?? '';
    if (/GetSystemDateAndTimeResponse/.test(text)) return { match: true, confidence: 0.9 };
    if (/Envelope/.test(text) && /onvif\.org|ter:|NotAuthorized/i.test(text)) return { match: true, confidence: 0.6 };
    return { match: false, confidence: 0 };
  } catch {
    return { match: false, confidence: 0 };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------- imaging

const IR_TO_CANONICAL = { AUTO: 'auto', ON: 'day', OFF: 'night' };
const IR_FROM_CANONICAL = { auto: 'AUTO', day: 'ON', night: 'OFF' };

/** canonical key -> how it lives in the imaging.js settings shape */
const IMAGING = [
  { key: 'image.brightness', label: 'Brightness', field: 'brightness', option: 'brightness', kind: 'range' },
  { key: 'image.contrast', label: 'Contrast', field: 'contrast', option: 'contrast', kind: 'range' },
  { key: 'image.saturation', label: 'Saturation', field: 'colorSaturation', option: 'colorSaturation', kind: 'range' },
  { key: 'image.sharpness', label: 'Sharpness', field: 'sharpness', option: 'sharpness', kind: 'range' },
  { key: 'image.dayNight', label: 'Day/night (IR-cut)', field: 'irCutFilter', option: 'irCutFilter', kind: 'ircut' },
  { key: 'image.wdr', label: 'Wide dynamic range', field: 'wideDynamicRange', option: 'wideDynamicRangeModes', kind: 'mode' },
  { key: 'image.blc', label: 'Backlight compensation', field: 'backlightCompensation', option: 'backlightCompensationModes', kind: 'mode' },
];

function imagingValue(spec, settings) {
  const raw = settings?.[spec.field];
  if (raw === undefined || raw === null) return undefined;
  if (spec.kind === 'range') return raw;
  if (spec.kind === 'ircut') return IR_TO_CANONICAL[String(raw).toUpperCase()];
  if (spec.kind === 'mode') return raw.mode === undefined ? undefined : String(raw.mode).toUpperCase() === 'ON';
  return undefined;
}

function imagingPatch(spec, value) {
  if (spec.kind === 'range') return [spec.field, value];
  if (spec.kind === 'ircut') return [spec.field, IR_FROM_CANONICAL[value]];
  return [spec.field, { mode: value ? 'ON' : 'OFF' }];
}

function imagingDescriptors(result, sourceToken) {
  const out = [];
  for (const spec of IMAGING) {
    const value = imagingValue(spec, result.settings);
    if (value === undefined) continue;
    const option = result.options?.[spec.option];
    const d = { key: spec.key, label: spec.label, group: 'imaging', unit: null, resource: `imaging:${sourceToken}` };
    if (spec.kind === 'range') {
      Object.assign(d, { type: 'number', writable: Boolean(option) });
      if (option) Object.assign(d, { min: option.min, max: option.max, step: option.step });
    } else if (spec.kind === 'ircut') {
      const values = (option ?? []).map((m) => IR_TO_CANONICAL[String(m).toUpperCase()]).filter(Boolean);
      Object.assign(d, { type: 'enum', values: values.length ? values : [value], writable: values.length > 0 });
    } else {
      const modes = (option ?? []).map((m) => String(m).toUpperCase());
      Object.assign(d, { type: 'bool', writable: modes.includes('ON') && modes.includes('OFF') });
    }
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- encoder

const CODEC_TO_CANONICAL = { H264: 'H.264', H265: 'H.265', JPEG: 'MJPEG' };
const CODEC_FROM_CANONICAL = { 'H.264': 'H264', 'H.265': 'H265', MJPEG: 'JPEG' };

function encoderValues(current) {
  const out = {};
  if (current.encoding) out['video.codec'] = CODEC_TO_CANONICAL[current.encoding] ?? current.encoding;
  if (current.width && current.height) out['video.resolution'] = `${current.width}x${current.height}`;
  if (current.fps !== undefined) out['video.fps'] = current.fps;
  if (current.bitrateKbps !== undefined) out['video.bitrate'] = current.bitrateKbps;
  if (current.govLength !== undefined) out['video.gop'] = current.govLength;
  if (current.quality !== undefined) out['vendor.onvif.quality'] = current.quality;
  return out;
}

function encoderDescriptors({ current, options }, profileToken) {
  const resource = `encoder:${profileToken}`;
  const values = encoderValues(current);
  const base = { group: 'encoder', resource };
  const out = [];
  if ('video.codec' in values) {
    const codecs = (options.encodings ?? []).filter((e) => CODEC_TO_CANONICAL[e]).map((e) => CODEC_TO_CANONICAL[e]);
    out.push({ ...base, key: 'video.codec', label: 'Codec', type: 'enum', unit: null,
      values: codecs.length ? codecs : [values['video.codec']], writable: codecs.length > 0 });
  }
  if ('video.resolution' in values) {
    const list = (options.resolutions?.[current.encoding] ?? []).map((r) => `${r.width}x${r.height}`);
    out.push({ ...base, key: 'video.resolution', label: 'Resolution', type: 'enum', unit: null,
      values: list.length ? list : [values['video.resolution']], writable: list.length > 0 });
  }
  const ranged = [
    ['video.fps', 'Frame rate', 'number', 'fps', options.fps],
    ['video.bitrate', 'Bitrate', 'int', 'kbps', options.bitrate],
    ['video.gop', 'GOP length', 'int', null, options.govLength],
    ['vendor.onvif.quality', 'Quality', 'number', null, options.quality],
  ];
  for (const [key, labelText, type, unit, range] of ranged) {
    if (!(key in values)) continue;
    const d = { ...base, key, label: labelText, type, unit, writable: Boolean(range) };
    if (range) Object.assign(d, { min: range.min, max: range.max, step: 1 });
    out.push(d);
  }
  return out;
}

function encoderPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'video.codec') out.encoding = CODEC_FROM_CANONICAL[value] ?? value;
    else if (key === 'video.resolution') {
      const [w, h] = value.split('x').map(Number);
      out.width = w;
      out.height = h;
    } else if (key === 'video.fps') out.fps = value;
    else if (key === 'video.bitrate') out.bitrateKbps = value;
    else if (key === 'video.gop') out.govLength = value;
    else if (key === 'vendor.onvif.quality') out.quality = value;
  }
  return out;
}

// ---------------------------------------------------------------- connection

function outcomes(patch, before, after, descriptors) {
  const byKey = Object.fromEntries(descriptors.map((d) => [d.key, d]));
  const results = {};
  const values = {};
  for (const [key, requested] of Object.entries(patch)) {
    const observed = after[key];
    results[key] = { outcome: classify({ requested, before: before[key], observed, descriptor: byKey[key] }), requested, observed };
    if (observed !== undefined) values[key] = observed;
  }
  return { results, values };
}

/**
 * Wrap an already-connected ONVIF session (the shape server/sessions.js
 * builds). The kernel uses this so an ONVIF session never connects twice.
 */
export function fromSession(session) {
  const resourceLock = (resource, fn) => withResourceLock(lockKey(session.host, session.port, resource), fn);

  function targets() {
    const list = [];
    const imaging = session.capabilities?.imaging !== false;
    (session.sources ?? []).forEach((source, index) => {
      const channel = index + 1;
      if (source.token && imaging && source.profiles?.length) {
        list.push({ id: `source:${source.token}`, scope: 'source', label: source.label ?? `Channel ${channel}`, channel });
      }
      for (const profile of source.profiles ?? []) {
        list.push({
          id: `stream:${profile.token}`,
          scope: 'stream',
          label: `${source.label ?? `Channel ${channel}`} · ${profile.name ?? profile.token}`,
          channel,
          parent: source.token ? `source:${source.token}` : undefined,
        });
      }
    });
    return list;
  }

  function resolve(targetId) {
    const target = targets().find((t) => t.id === targetId);
    if (!target) throw new AppError('NOT_FOUND', `This device has no target "${targetId}".`);
    if (target.scope === 'source') {
      const token = targetId.slice('source:'.length);
      const source = session.sources.find((s) => s.token === token);
      return { target, kind: 'imaging', token, profileToken: source.profiles[0].token };
    }
    const profileToken = targetId.slice('stream:'.length);
    return { target, kind: 'encoder', token: profileToken, profileToken };
  }

  async function describe(r) {
    if (r.kind === 'imaging') return imagingDescriptors(await readImaging(session, r.profileToken), r.token);
    return encoderDescriptors(await readEncoder(session, r.profileToken), r.profileToken);
  }

  async function readValues(r) {
    if (r.kind === 'imaging') {
      const result = await readImaging(session, r.profileToken);
      const values = {};
      for (const spec of IMAGING) {
        const v = imagingValue(spec, result.settings);
        if (v !== undefined) values[spec.key] = v;
      }
      return { values, source: result.source ?? id };
    }
    return { values: encoderValues((await readEncoder(session, r.profileToken)).current), source: id };
  }

  return {
    id,
    label,
    session,
    info: {
      vendor: session.device?.manufacturer ?? null,
      model: session.device?.model ?? null,
      firmware: session.device?.firmware ?? null,
      serial: session.device?.serial ?? null,
    },
    async listTargets() {
      return targets();
    },
    async describeSettings(targetId) {
      return describe(resolve(targetId));
    },
    async read(targetId, keys) {
      const { values, source } = await readValues(resolve(targetId));
      const picked = keys ? Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])) : values;
      return { values: picked, source };
    },
    async write(targetId, patch) {
      const r = resolve(targetId);
      const descriptors = await describe(r);
      validatePatch(patch, descriptors);
      return resourceLock(`${r.kind}:${r.token}`, async () => {
        const before = (await readValues(r)).values;
        if (r.kind === 'imaging') {
          // writeImaging polls the read-back itself, and applies the existing
          // Vatilon stub fallback (VENDOR.md) — the result's source says which
          // path produced it.
          const onvifPatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => (
            imagingPatch(IMAGING.find((s) => s.key === key), value))));
          const result = await writeImaging(session, r.profileToken, onvifPatch);
          const after = {};
          for (const spec of IMAGING) {
            const v = imagingValue(spec, result.settings);
            if (v !== undefined) after[spec.key] = v;
          }
          return { source: result.source ?? id, ...outcomes(patch, before, after, descriptors) };
        }
        const result = await writeEncoder(session, r.profileToken, encoderPatch(patch));
        return { source: id, ...outcomes(patch, before, encoderValues(result.current), descriptors), encoderPatch: encoderPatch(patch) };
      });
    },
    close() { /* the session owns the ONVIF client */ },
  };
}

/** Standalone connect, for a caller that has no session (ADAPTERS.md §5). */
export async function connect(cfg) {
  const result = await connectDevice(cfg);
  const session = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    ...result,
    ctx: { host: cfg.host, port: cfg.port },
    timeoutMs: config.onvifTimeoutMs,
  };
  return fromSession(session);
}
