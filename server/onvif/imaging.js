import { AppError } from '../errors.js';
import { callCam, tryCam, asArray, num } from './util.js';

const SCHEMA = 'http://www.onvif.org/ver10/schema';
const IMG20 = 'http://www.onvif.org/ver20/imaging/wsdl';

function sourceTokenFor(session, profileToken) {
  const profile = session.profileMap.get(profileToken);
  return profile?.videoSourceToken ?? session.cam?.activeSource?.sourceToken ?? null;
}

function range(node) {
  if (!node) return null;
  const min = num(node.min ?? node.Min);
  const max = num(node.max ?? node.Max);
  if (min === null || max === null) return null;
  // Integer-looking ranges get a step of 1; float ranges get something usable.
  const span = max - min;
  const step = Number.isInteger(min) && Number.isInteger(max) && span >= 10 ? 1 : Number((span / 100).toPrecision(2));
  return { min, max, step: step || 0.01 };
}

function modes(node) {
  const list = asArray(node).map(String).filter(Boolean);
  return list.length ? list : null;
}

/** Map ONVIF ImagingSettings20 into the API.md shape, omitting absent keys. */
function readSettings(s) {
  if (!s) return {};
  const out = {};
  if (s.brightness !== undefined) out.brightness = num(s.brightness);
  if (s.contrast !== undefined) out.contrast = num(s.contrast);
  if (s.colorSaturation !== undefined) out.colorSaturation = num(s.colorSaturation);
  if (s.sharpness !== undefined) out.sharpness = num(s.sharpness);
  if (s.irCutFilter !== undefined) out.irCutFilter = String(s.irCutFilter).toUpperCase();

  if (s.whiteBalance) {
    out.whiteBalance = {
      mode: String(s.whiteBalance.mode ?? 'AUTO').toUpperCase(),
      crGain: num(s.whiteBalance.crGain),
      cbGain: num(s.whiteBalance.cbGain),
    };
  }
  if (s.exposure) {
    out.exposure = {
      mode: String(s.exposure.mode ?? 'AUTO').toUpperCase(),
      priority: s.exposure.priority ? String(s.exposure.priority) : null,
      minExposureTime: num(s.exposure.minExposureTime),
      maxExposureTime: num(s.exposure.maxExposureTime),
      minGain: num(s.exposure.minGain),
      maxGain: num(s.exposure.maxGain),
      exposureTime: num(s.exposure.exposureTime),
      gain: num(s.exposure.gain),
      iris: num(s.exposure.iris),
    };
  }
  if (s.focus) {
    out.focus = {
      autoFocusMode: String(s.focus.autoFocusMode ?? 'AUTO').toUpperCase(),
      defaultSpeed: num(s.focus.defaultSpeed),
      nearLimit: num(s.focus.nearLimit),
      farLimit: num(s.focus.farLimit),
    };
  }
  if (s.wideDynamicRange) {
    out.wideDynamicRange = {
      mode: String(s.wideDynamicRange.mode ?? 'OFF').toUpperCase(),
      level: num(s.wideDynamicRange.level, 0),
    };
  }
  if (s.backlightCompensation) {
    out.backlightCompensation = {
      mode: String(s.backlightCompensation.mode ?? 'OFF').toUpperCase(),
      level: num(s.backlightCompensation.level, 0),
    };
  }
  return out;
}

/**
 * Slider bounds come from the device, never from us. A Hikvision reporting
 * 0..100 and an Axis reporting 0..1 both have to drive the same UI correctly.
 */
function readOptions(o) {
  if (!o) return {};
  const out = {};
  const b = range(o.brightness);
  if (b) out.brightness = b;
  const c = range(o.contrast);
  if (c) out.contrast = c;
  const cs = range(o.colorSaturation);
  if (cs) out.colorSaturation = cs;
  const sh = range(o.sharpness);
  if (sh) out.sharpness = sh;

  const ir = modes(o.irCutFilterModes);
  if (ir) out.irCutFilter = ir;
  const wb = modes(o.whiteBalance?.mode);
  if (wb) out.whiteBalanceModes = wb;
  const ex = modes(o.exposure?.mode);
  if (ex) out.exposureModes = ex;
  const af = modes(o.focus?.autoFocusModes);
  if (af) out.autoFocusModes = af;
  const wdr = modes(o.wideDynamicRange?.mode);
  if (wdr) out.wideDynamicRangeModes = wdr;
  const blc = modes(o.backlightCompensation?.mode);
  if (blc) out.backlightCompensationModes = blc;

  const wdrLevel = range(o.wideDynamicRange?.level);
  if (wdrLevel) out.wideDynamicRangeLevel = wdrLevel;
  const blcLevel = range(o.backlightCompensation?.level);
  if (blcLevel) out.backlightCompensationLevel = blcLevel;

  const expTime = range(o.exposure?.exposureTime);
  if (expTime) out.exposureTime = expTime;
  const gain = range(o.exposure?.gain);
  if (gain) out.gain = gain;
  return out;
}

export async function readImaging(session, profileToken) {
  const token = sourceTokenFor(session, profileToken);
  if (!token) {
    throw new AppError('UNSUPPORTED', 'This profile has no video source to read imaging settings from.');
  }
  const [settings, options] = await Promise.all([
    callCam(session.cam, 'getImagingSettings', { token }, { ctx: session.ctx }),
    tryCam(session.cam, 'getVideoSourceOptions', { token }, null, { ctx: session.ctx }),
  ]);
  return { settings: readSettings(settings), options: readOptions(options) };
}

const esc = (v) => String(v).replace(/[<>&"']/g, (ch) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
));
const el = (name, value) => `<${name} xmlns="${SCHEMA}">${esc(value)}</${name}>`;

/**
 * Build SetImagingSettings by hand.
 *
 * The `onvif` library's setImagingSettings guards every field with a truthiness
 * check, so a legitimate value of 0 (brightness 0, WDR level 0) is silently
 * dropped from the request. It also cannot express IrCutFilter, WideDynamicRange
 * or BacklightCompensation at all. Elements are emitted in the XSD sequence
 * order required by ImagingSettings20 — devices reject out-of-order children.
 */
function buildImagingBody(token, patch, current) {
  const merged = { ...current, ...patch };
  const parts = [];

  const blc = patch.backlightCompensation ?? (patch.backlightCompensationLevel !== undefined ? merged.backlightCompensation : null);
  if (blc) {
    parts.push(`<BacklightCompensation xmlns="${SCHEMA}">` +
      el('Mode', String(blc.mode ?? 'OFF').toUpperCase()) +
      (blc.level !== undefined && blc.level !== null ? el('Level', blc.level) : '') +
      '</BacklightCompensation>');
  }
  if (patch.brightness !== undefined && patch.brightness !== null) parts.push(el('Brightness', patch.brightness));
  if (patch.colorSaturation !== undefined && patch.colorSaturation !== null) parts.push(el('ColorSaturation', patch.colorSaturation));
  if (patch.contrast !== undefined && patch.contrast !== null) parts.push(el('Contrast', patch.contrast));

  if (patch.exposure) {
    const e = patch.exposure;
    const seq = [
      ['Mode', e.mode], ['Priority', e.priority],
      ['MinExposureTime', e.minExposureTime], ['MaxExposureTime', e.maxExposureTime],
      ['MinGain', e.minGain], ['MaxGain', e.maxGain],
      ['ExposureTime', e.exposureTime], ['Gain', e.gain], ['Iris', e.iris],
    ].filter(([, v]) => v !== undefined && v !== null);
    if (seq.length) {
      parts.push(`<Exposure xmlns="${SCHEMA}">` + seq.map(([k, v]) => el(k, v)).join('') + '</Exposure>');
    }
  }
  if (patch.focus) {
    const f = patch.focus;
    const seq = [
      ['AutoFocusMode', f.autoFocusMode], ['DefaultSpeed', f.defaultSpeed],
      ['NearLimit', f.nearLimit], ['FarLimit', f.farLimit],
    ].filter(([, v]) => v !== undefined && v !== null);
    if (seq.length) {
      parts.push(`<Focus xmlns="${SCHEMA}">` + seq.map(([k, v]) => el(k, v)).join('') + '</Focus>');
    }
  }
  if (patch.irCutFilter) parts.push(el('IrCutFilter', String(patch.irCutFilter).toUpperCase()));
  if (patch.sharpness !== undefined && patch.sharpness !== null) parts.push(el('Sharpness', patch.sharpness));

  if (patch.wideDynamicRange) {
    const w = patch.wideDynamicRange;
    parts.push(`<WideDynamicRange xmlns="${SCHEMA}">` +
      el('Mode', String(w.mode ?? 'OFF').toUpperCase()) +
      (w.level !== undefined && w.level !== null ? el('Level', w.level) : '') +
      '</WideDynamicRange>');
  }
  if (patch.whiteBalance) {
    const w = patch.whiteBalance;
    parts.push(`<WhiteBalance xmlns="${SCHEMA}">` +
      el('Mode', String(w.mode ?? 'AUTO').toUpperCase()) +
      (w.crGain !== undefined && w.crGain !== null ? el('CrGain', w.crGain) : '') +
      (w.cbGain !== undefined && w.cbGain !== null ? el('CbGain', w.cbGain) : '') +
      '</WhiteBalance>');
  }

  if (!parts.length) return null;
  return `<SetImagingSettings xmlns="${IMG20}">` +
    `<VideoSourceToken xmlns="${IMG20}">${esc(token)}</VideoSourceToken>` +
    `<ImagingSettings xmlns="${IMG20}">${parts.join('')}</ImagingSettings>` +
    `<ForcePersistence xmlns="${IMG20}">true</ForcePersistence>` +
    '</SetImagingSettings>';
}

function rawRequest(cam, service, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', 'The device did not answer the imaging request in time.'));
    }, timeoutMs);
    try {
      cam._request({ service, body: cam._envelopeHeader() + body + cam._envelopeFooter() }, (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(data);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function writeImaging(session, profileToken, patch) {
  const token = sourceTokenFor(session, profileToken);
  if (!token) throw new AppError('UNSUPPORTED', 'This profile has no video source to write imaging settings to.');

  const before = await readImaging(session, profileToken);
  const body = buildImagingBody(token, patch, before.settings);
  if (!body) throw new AppError('BAD_REQUEST', 'No recognized imaging settings were supplied.');

  const { mapOnvifError } = await import('../errors.js');
  try {
    await rawRequest(session.cam, 'imaging', body, session.timeoutMs);
  } catch (err) {
    throw mapOnvifError(err, session.ctx);
  }
  // Return the device's post-write state, not our optimistic guess: cameras
  // clamp, quantize, and sometimes ignore values outright.
  return readImaging(session, profileToken);
}

export async function focusMove(session, profileToken, { action, speed, position }) {
  const token = sourceTokenFor(session, profileToken);
  if (!token) throw new AppError('UNSUPPORTED', 'This profile has no video source to focus.');

  if (action === 'stop') {
    await callCam(session.cam, 'imagingStop', { token }, { ctx: session.ctx });
    return;
  }
  if (action === 'absolute') {
    await callCam(session.cam, 'imagingMove', {
      token, focus: { absolute: { position: Number(position ?? 0), speed: Number(speed ?? 0.5) } },
    }, { ctx: session.ctx });
    return;
  }
  await callCam(session.cam, 'imagingMove', {
    token, focus: { continuous: { speed: Number(speed ?? 0.5) } },
  }, { ctx: session.ctx });
}
