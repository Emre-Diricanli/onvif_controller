import { AppError } from '../errors.js';
import { withGovernor } from '../device/governor.js';
import { callCam, tryCam, asArray, num } from './util.js';
import {
  ONVIF_SOURCE, looksLikeOnvifStub, tryVendorWrite, tryVendorRead, vendorDriverId, vendorDriverLabel,
} from '../vendor/index.js';

const SCHEMA = 'http://www.onvif.org/ver10/schema';
const IMG20 = 'http://www.onvif.org/ver20/imaging/wsdl';

/**
 * Resolve the video source token the Imaging service will actually accept.
 *
 * The profile's `videoSourceConfiguration.sourceToken` is NOT reliable. A real
 * Hikvision camera here reports the literal placeholder string
 * "videoSourceToken", and addressing that token makes the camera answer
 * GetImagingSettings with a generic default (128 on every channel) and accept
 * SetImagingSettings with an empty success response while changing nothing —
 * a silent no-op that looks exactly like a refused write.
 *
 * So validate against the real source list from GetVideoSources, and only fall
 * back to the profile's claim when the device offers nothing better.
 */
function realSourceTokens(session) {
  return asArray(session.cam?.videoSources)
    .map((v) => v?.$?.token ?? v?.token)
    .filter((t) => typeof t === 'string' && t.length > 0);
}

function sourceTokenFor(session, profileToken) {
  const profile = session.profileMap.get(profileToken);
  const claimed = profile?.videoSourceToken ?? null;
  const real = realSourceTokens(session);
  const active = session.cam?.activeSource?.sourceToken ?? null;

  // Trust the profile only if the device actually lists that source.
  if (claimed && real.includes(claimed)) return claimed;
  if (real.length > 1) {
    throw new AppError('UNSUPPORTED', 'A specific channel is required for imaging settings on this multi-channel device.');
  }
  if (active && real.includes(active)) return active;
  if (real.length > 0) return real[0];
  return claimed ?? active ?? null;
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
    out.whiteBalance = {};
    if (s.whiteBalance.mode !== undefined) out.whiteBalance.mode = String(s.whiteBalance.mode).toUpperCase();
    if (s.whiteBalance.crGain !== undefined) out.whiteBalance.crGain = num(s.whiteBalance.crGain);
    if (s.whiteBalance.cbGain !== undefined) out.whiteBalance.cbGain = num(s.whiteBalance.cbGain);
  }
  if (s.exposure) {
    out.exposure = {};
    for (const key of ['minExposureTime', 'maxExposureTime', 'minGain', 'maxGain', 'exposureTime', 'gain', 'iris']) {
      if (s.exposure[key] !== undefined) out.exposure[key] = num(s.exposure[key]);
    }
    if (s.exposure.mode !== undefined) out.exposure.mode = String(s.exposure.mode).toUpperCase();
    if (s.exposure.priority !== undefined) out.exposure.priority = String(s.exposure.priority);
  }
  if (s.focus) {
    out.focus = {};
    if (s.focus.autoFocusMode !== undefined) out.focus.autoFocusMode = String(s.focus.autoFocusMode).toUpperCase();
    for (const key of ['defaultSpeed', 'nearLimit', 'farLimit']) {
      if (s.focus[key] !== undefined) out.focus[key] = num(s.focus[key]);
    }
  }
  if (s.wideDynamicRange) {
    out.wideDynamicRange = {};
    if (s.wideDynamicRange.mode !== undefined) out.wideDynamicRange.mode = String(s.wideDynamicRange.mode).toUpperCase();
    if (s.wideDynamicRange.level !== undefined) out.wideDynamicRange.level = num(s.wideDynamicRange.level);
  }
  if (s.backlightCompensation) {
    out.backlightCompensation = {};
    if (s.backlightCompensation.mode !== undefined) out.backlightCompensation.mode = String(s.backlightCompensation.mode).toUpperCase();
    if (s.backlightCompensation.level !== undefined) out.backlightCompensation.level = num(s.backlightCompensation.level);
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

/** The library populates cam.videoSources during connect; refetch if it did not. */
async function ensureVideoSources(session) {
  if (realSourceTokens(session).length > 0) return;
  await tryCam(session.cam, 'getVideoSources', undefined, null, { ctx: session.ctx });
}

export async function readImaging(session, profileToken) {
  await ensureVideoSources(session);
  const token = sourceTokenFor(session, profileToken);
  if (!token) {
    throw new AppError('UNSUPPORTED', 'This profile has no video source to read imaging settings from.');
  }
  const [settings, options] = await Promise.all([
    callCam(session.cam, 'getImagingSettings', { token }, { ctx: session.ctx }),
    tryCam(session.cam, 'getVideoSourceOptions', { token }, null, { ctx: session.ctx }),
  ]);
  if (process.env.DEBUG_ONVIF) {
    // The video source token is the usual suspect when a camera accepts an
    // imaging write and silently ignores it, so make it visible.
    console.log('[onvif imaging] videoSourceToken used:', JSON.stringify(token),
      '| device sources:', JSON.stringify(realSourceTokens(session)),
      '| profile claimed:', JSON.stringify(session.profileMap.get(profileToken)?.videoSourceToken ?? null));
    console.log('[onvif imaging] GetImagingSettings raw:', safeTrace(JSON.stringify(settings)));
  }
  const onvifResult = {
    settings: readSettings(settings),
    options: readOptions(options),
    source: ONVIF_SOURCE,
  };

  // Once a driver owns the picture, ONVIF's numbers are stale fiction: the
  // camera reports its own defaults regardless of what was actually set.
  if (session.vendor?.owns) {
    const vendor = await tryVendorRead(session);
    if (vendor) {
      return {
        ...vendor,
        // Keep ONVIF's ranges where the driver could not determine one.
        options: { ...onvifResult.options, ...vendor.options },
        driver: vendorDriverLabel(session),
      };
    }
  }

  return onvifResult;
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
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key)) continue;
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(current[key] ?? {}), ...value }
      : value;
  }
  const parts = [];

  const blc = merged.backlightCompensation;
  if (blc) {
    const children = (blc.mode !== undefined && blc.mode !== null ? el('Mode', String(blc.mode).toUpperCase()) : '') +
      (blc.level !== undefined && blc.level !== null ? el('Level', blc.level) : '');
    if (children) parts.push(`<BacklightCompensation xmlns="${SCHEMA}">${children}</BacklightCompensation>`);
  }
  if (merged.brightness !== undefined && merged.brightness !== null) parts.push(el('Brightness', merged.brightness));
  if (merged.colorSaturation !== undefined && merged.colorSaturation !== null) parts.push(el('ColorSaturation', merged.colorSaturation));
  if (merged.contrast !== undefined && merged.contrast !== null) parts.push(el('Contrast', merged.contrast));

  if (merged.exposure) {
    const e = merged.exposure;
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
  if (merged.focus) {
    const f = merged.focus;
    const seq = [
      ['AutoFocusMode', f.autoFocusMode], ['DefaultSpeed', f.defaultSpeed],
      ['NearLimit', f.nearLimit], ['FarLimit', f.farLimit],
    ].filter(([, v]) => v !== undefined && v !== null);
    if (seq.length) {
      parts.push(`<Focus xmlns="${SCHEMA}">` + seq.map(([k, v]) => el(k, v)).join('') + '</Focus>');
    }
  }
  if (merged.irCutFilter !== undefined && merged.irCutFilter !== null) parts.push(el('IrCutFilter', String(merged.irCutFilter).toUpperCase()));
  if (merged.sharpness !== undefined && merged.sharpness !== null) parts.push(el('Sharpness', merged.sharpness));

  if (merged.wideDynamicRange) {
    const w = merged.wideDynamicRange;
    const children = (w.mode !== undefined && w.mode !== null ? el('Mode', String(w.mode).toUpperCase()) : '') +
      (w.level !== undefined && w.level !== null ? el('Level', w.level) : '');
    if (children) parts.push(`<WideDynamicRange xmlns="${SCHEMA}">${children}</WideDynamicRange>`);
  }
  if (merged.whiteBalance) {
    const w = merged.whiteBalance;
    const children = (w.mode !== undefined && w.mode !== null ? el('Mode', String(w.mode).toUpperCase()) : '') +
      (w.crGain !== undefined && w.crGain !== null ? el('CrGain', w.crGain) : '') +
      (w.cbGain !== undefined && w.cbGain !== null ? el('CbGain', w.cbGain) : '');
    if (children) parts.push(`<WhiteBalance xmlns="${SCHEMA}">${children}</WhiteBalance>`);
  }

  if (!parts.length) return null;
  return `<SetImagingSettings xmlns="${IMG20}">` +
    `<VideoSourceToken xmlns="${IMG20}">${esc(token)}</VideoSourceToken>` +
    `<ImagingSettings xmlns="${IMG20}">${parts.join('')}</ImagingSettings>` +
    `<ForcePersistence xmlns="${IMG20}">true</ForcePersistence>` +
    '</SetImagingSettings>';
}

/**
 * Hand-built SOAP bypasses the `onvif` library, so it must be routed through
 * the per-host governor explicitly — these are the paths a probe storm would
 * otherwise escape through (GOVERNOR.md).
 */
function rawRequest(cam, service, body, timeoutMs) {
  return withGovernor(cam?.hostname, () => rawRequestUngoverned(cam, service, body, timeoutMs));
}

function rawRequestUngoverned(cam, service, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', 'The device did not answer the imaging request in time.'));
    }, timeoutMs);
    try {
      cam._request({ service, body: cam._envelopeHeader() + body + cam._envelopeFooter() }, (err, data, xml) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ data, xml });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

function safeTrace(value) {
  return String(value ?? '')
    .replace(/(<(?:\w+:)?Password\b[^>]*>)[\s\S]*?(<\/(?:\w+:)?Password>)/gi, '$1[REDACTED]$2')
    .replace(/rtsp:\/\/[^\s<"']+/gi, 'rtsp://[REDACTED]');
}

function reportedPatch(patch, current) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const reportedChildren = current[key] && typeof current[key] === 'object' ? current[key] : {};
      const children = Object.fromEntries(Object.entries(value).filter(([child]) => Object.hasOwn(reportedChildren, child)));
      if (Object.keys(children).length) out[key] = children;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function writeImaging(session, profileToken, patch) {
  await ensureVideoSources(session);
  const token = sourceTokenFor(session, profileToken);
  if (!token) throw new AppError('UNSUPPORTED', 'This profile has no video source to write imaging settings to.');

  const before = await readImaging(session, profileToken);
  const effectivePatch = reportedPatch(patch, before.settings);
  if (Object.keys(effectivePatch).length === 0) throw new AppError('BAD_REQUEST', 'No recognized imaging settings were supplied.');
  const body = buildImagingBody(token, effectivePatch, before.settings);
  if (!body) throw new AppError('BAD_REQUEST', 'No recognized imaging settings were supplied.');

  const { mapOnvifError } = await import('../errors.js');
  try {
    if (process.env.DEBUG_ONVIF) console.log('[onvif imaging] SetImagingSettings request:', safeTrace(body));
    const response = await rawRequest(session.cam, 'imaging', body, session.timeoutMs);
    if (process.env.DEBUG_ONVIF) console.log('[onvif imaging] SetImagingSettings response:', safeTrace(response.xml ?? response.data));
  } catch (err) {
    throw mapOnvifError(err, session.ctx);
  }
  let after = before;
  const patched = Object.entries(effectivePatch);
  for (const delayMs of [150, 400, 900]) {
    await wait(delayMs);
    after = await readImaging(session, profileToken);
    const settled = patched.every(([key, requested]) => {
      const actual = after.settings[key];
      const old = before.settings[key];
      if (requested && typeof requested === 'object') {
        return Object.entries(requested).every(([subkey, value]) => same(actual?.[subkey], value) || !same(actual?.[subkey], old?.[subkey]));
      }
      return same(actual, requested) || !same(actual, old);
    });
    if (settled) break;
  }
  after.source = ONVIF_SOURCE;
  after.applied = Object.fromEntries(patched.map(([key, requested]) => {
    const actual = after.settings[key];
    const old = before.settings[key];
    const accepted = requested && typeof requested === 'object'
      ? Object.entries(requested).every(([subkey, value]) => same(actual?.[subkey], value) || !same(actual?.[subkey], old?.[subkey]))
      : same(actual, requested) || !same(actual, old);
    return [key, accepted];
  }));

  // ONVIF said yes and changed nothing. That is the signature of a stub
  // Imaging service, and the only point at which a proprietary API is worth
  // reaching for. Everything up to here is unchanged for a camera that works.
  if (looksLikeOnvifStub(after.applied)) {
    const vendor = await tryVendorWrite(session, effectivePatch);
    if (vendor && looksLikeOnvifStub(vendor.applied) === false) {
      session.vendor.owns = true;
      return {
        ...vendor,
        options: { ...after.options, ...vendor.options },
        driver: vendorDriverLabel(session),
      };
    }
  }

  return after;
}

export async function focusMove(session, profileToken, { action, speed, position }) {
  await ensureVideoSources(session);
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
