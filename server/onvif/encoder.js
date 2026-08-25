import { AppError } from '../errors.js';
import { callCam, asArray, num } from './util.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokenOf = (value) => value?.$?.token ?? value?.token ?? null;
const upper = (value) => String(value ?? '').toUpperCase();

function safeTrace(value) {
  return String(value ?? '')
    .replace(/(<(?:\w+:)?Password\b[^>]*>)[\s\S]*?(<\/(?:\w+:)?Password>)/gi, '$1[REDACTED]$2')
    .replace(/rtsp:\/\/[^\s<"']+/gi, 'rtsp://[REDACTED]');
}

function trace(label, value) {
  if (process.env.DEBUG_ONVIF) {
    console.log(`[onvif encoder] ${label}:`, safeTrace(JSON.stringify(value)));
  }
}

function range(node) {
  if (!node) return null;
  const min = num(node.min ?? node.Min);
  const max = num(node.max ?? node.Max);
  return min === null || max === null ? null : { min, max };
}

function resolutionList(node) {
  const seen = new Set();
  return asArray(node).flatMap((item) => {
    const width = num(item?.width ?? item?.Width);
    const height = num(item?.height ?? item?.Height);
    const key = `${width}x${height}`;
    if (width === null || height === null || seen.has(key)) return [];
    seen.add(key);
    return [{ width, height }];
  });
}

function codecNodes(options) {
  const roots = [options, options?.extension, options?.extension?.extension].filter(Boolean);
  const out = new Map();
  for (const root of roots) {
    for (const [key, value] of Object.entries(root)) {
      const encoding = upper(key);
      if (!['JPEG', 'MPEG4', 'H264', 'H265'].includes(encoding) || !value) continue;
      out.set(encoding, { ...(out.get(encoding) ?? {}), ...value });
    }
  }
  return out;
}

function apiOptions(raw) {
  if (!raw) return {};
  const codecs = codecNodes(raw);
  const out = {};
  if (codecs.size) {
    out.encodings = [...codecs.keys()];
    out.resolutions = Object.fromEntries([...codecs].map(([encoding, node]) => [
      encoding, resolutionList(node.resolutionsAvailable ?? node.ResolutionsAvailable),
    ]));
  }

  // These ranges can be codec-specific. The API exposes the selected codec's
  // limits, falling back to a generic range only when the camera supplies one.
  return { ...out, _codecs: codecs };
}

function limitsFor(raw, encoding) {
  const parsed = apiOptions(raw);
  const node = parsed._codecs.get(upper(encoding)) ?? {};
  const out = {};
  const fps = range(node.frameRateRange ?? raw?.frameRateRange);
  const bitrate = range(node.bitrateRange ?? raw?.bitrateRange ?? raw?.extension?.bitrateRange);
  const govLength = range(node.govLengthRange ?? raw?.govLengthRange);
  const quality = range(raw?.qualityRange ?? node.qualityRange);
  if (fps) out.fps = fps;
  if (bitrate) out.bitrate = bitrate;
  if (govLength) out.govLength = govLength;
  if (quality) out.quality = quality;
  delete parsed._codecs;
  return { ...parsed, ...out };
}

function apiCurrent(cfg) {
  const encoding = upper(cfg?.encoding ?? cfg?.Encoding);
  const codec = cfg?.[encoding] ?? cfg?.[encoding === 'H264' ? 'h264' : encoding === 'H265' ? 'h265' : encoding];
  const out = {
    token: tokenOf(cfg),
    name: cfg?.name ?? cfg?.Name ?? null,
    encoding,
    width: num(cfg?.resolution?.width ?? cfg?.Resolution?.Width),
    height: num(cfg?.resolution?.height ?? cfg?.Resolution?.Height),
    fps: num(cfg?.rateControl?.frameRateLimit ?? cfg?.RateControl?.FrameRateLimit),
    bitrateKbps: num(cfg?.rateControl?.bitrateLimit ?? cfg?.RateControl?.BitrateLimit),
    govLength: num(codec?.govLength ?? codec?.GovLength),
    quality: num(cfg?.quality ?? cfg?.Quality),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== null && value !== ''));
}

async function profileEncoderToken(session, profileToken) {
  let profile = asArray(session.cam?.profiles).find((item) => tokenOf(item) === profileToken);
  if (!profile) {
    const profiles = asArray(await callCam(session.cam, 'getProfiles', undefined, { ctx: session.ctx }));
    profile = profiles.find((item) => tokenOf(item) === profileToken);
  }
  const token = tokenOf(profile?.videoEncoderConfiguration);
  if (!token) {
    throw new AppError('UNSUPPORTED', 'This profile has no attached video encoder configuration.');
  }
  return token;
}

async function readRaw(session, profileToken) {
  const configurationToken = await profileEncoderToken(session, profileToken);
  const configurations = asArray(await callCam(
    session.cam, 'getVideoEncoderConfigurations', undefined, { ctx: session.ctx },
  ));
  const listed = configurations.find((cfg) => tokenOf(cfg) === configurationToken);
  const current = await callCam(
    session.cam, 'getVideoEncoderConfiguration', configurationToken, { ctx: session.ctx },
  );
  const options = await callCam(session.cam, 'getVideoEncoderConfigurationOptions', {
    configurationToken, profileToken,
  }, { ctx: session.ctx });
  trace('resolved tokens', { profileToken, configurationToken });
  trace('GetVideoEncoderConfiguration', current ?? listed);
  trace('GetVideoEncoderConfigurationOptions', options);
  return { configurationToken, current: current ?? listed, options };
}

export async function readEncoder(session, profileToken) {
  const raw = await readRaw(session, profileToken);
  const current = apiCurrent(raw.current);
  return { current, options: limitsFor(raw.options, current.encoding) };
}

function bad(message) {
  throw new AppError('BAD_REQUEST', message);
}

function validate(settings, current, options) {
  const allowed = new Set(options.encodings ?? []);
  const encoding = upper(settings.encoding ?? current.encoding);
  if (Object.hasOwn(settings, 'encoding') && !allowed.has(encoding)) {
    bad(`Unsupported encoding "${settings.encoding}". Allowed encodings: ${[...allowed].join(', ') || 'none reported'}.`);
  }
  const resolutions = options.resolutions?.[encoding];
  if (Object.hasOwn(settings, 'width') || Object.hasOwn(settings, 'height') || Object.hasOwn(settings, 'encoding')) {
    const width = num(settings.width, current.width);
    const height = num(settings.height, current.height);
    if (!resolutions?.some((item) => item.width === width && item.height === height)) {
      const allowedText = (resolutions ?? []).map((item) => `${item.width}x${item.height}`).join(', ');
      bad(`Resolution ${width}x${height} is not allowed for ${encoding}. Allowed resolutions: ${allowedText || 'none reported'}.`);
    }
  }
  for (const [field, option] of [['fps', 'fps'], ['bitrateKbps', 'bitrate'], ['govLength', 'govLength'], ['quality', 'quality']]) {
    if (!Object.hasOwn(settings, field)) continue;
    const value = num(settings[field]);
    const bounds = options[option];
    if (value === null || !bounds || value < bounds.min || value > bounds.max) {
      bad(`"${field}" must be within the device-reported range ${bounds ? `${bounds.min}-${bounds.max}` : '(no range reported)'}.`);
    }
  }
  return encoding;
}

function mergedConfiguration(raw, settings, encoding) {
  const cfg = structuredClone(raw);
  cfg.encoding = encoding;
  cfg.resolution = { ...(cfg.resolution ?? {}) };
  cfg.rateControl = { ...(cfg.rateControl ?? {}) };
  if (Object.hasOwn(settings, 'width')) cfg.resolution.width = Number(settings.width);
  if (Object.hasOwn(settings, 'height')) cfg.resolution.height = Number(settings.height);
  if (Object.hasOwn(settings, 'fps')) cfg.rateControl.frameRateLimit = Number(settings.fps);
  if (Object.hasOwn(settings, 'bitrateKbps')) cfg.rateControl.bitrateLimit = Number(settings.bitrateKbps);
  if (Object.hasOwn(settings, 'quality')) cfg.quality = Number(settings.quality);
  if (Object.hasOwn(settings, 'govLength')) {
    cfg[encoding] = { ...(cfg[encoding] ?? {}), govLength: Number(settings.govLength) };
  }
  cfg.token = tokenOf(raw);
  cfg.ForcePersistence = true;
  return cfg;
}

function same(a, b, field) {
  return field === 'encoding' ? upper(a) === upper(b) : Number(a) === Number(b);
}

export async function writeEncoder(session, profileToken, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('Encoder settings must be an object.');
  const recognized = ['encoding', 'width', 'height', 'fps', 'bitrateKbps', 'govLength', 'quality'];
  const settings = Object.fromEntries(Object.entries(patch).filter(([key]) => recognized.includes(key)));
  if (!Object.keys(settings).length) bad('No recognized encoder settings were supplied.');

  const beforeRaw = await readRaw(session, profileToken);
  const before = apiCurrent(beforeRaw.current);
  const options = limitsFor(beforeRaw.options, settings.encoding ?? before.encoding);
  const encoding = validate(settings, before, options);
  const complete = mergedConfiguration(beforeRaw.current, settings, encoding);
  trace('SetVideoEncoderConfiguration request', { ...complete, ForcePersistence: true });
  await callCam(session.cam, 'setVideoEncoderConfiguration', complete, { ctx: session.ctx });

  let after = before;
  for (const delayMs of [150, 400, 900]) {
    await wait(delayMs);
    const cfg = await callCam(session.cam, 'getVideoEncoderConfiguration', beforeRaw.configurationToken, { ctx: session.ctx });
    after = apiCurrent(cfg);
    if (Object.entries(settings).every(([field, value]) => same(after[field], value, field))) break;
  }
  const result = await readEncoder(session, profileToken);
  result.applied = Object.fromEntries(Object.entries(settings).map(([field, value]) => [
    field, same(result.current[field], value, field),
  ]));
  trace('verified read-back', { current: result.current, applied: result.applied });
  return result;
}
