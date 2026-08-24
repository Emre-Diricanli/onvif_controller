import { AppError, mapOnvifError } from '../errors.js';
import { config } from '../config.js';

/**
 * The `onvif` library is callback-based with two shapes: (options, cb) and (cb).
 * Wrap either into a promise with a hard timeout, because several Hikvision
 * firmwares accept a TCP connection and then never answer the SOAP request.
 */
export function callCam(cam, method, arg, { timeoutMs = config.onvifTimeoutMs, ctx = {} } = {}) {
  return new Promise((resolve, reject) => {
    const fn = cam?.[method];
    if (typeof fn !== 'function') {
      reject(new AppError('UNSUPPORTED', `This device does not expose "${method}".`));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', `The device did not answer "${method}" within ${timeoutMs}ms.`,
        'The camera may be overloaded or the ONVIF service may be wedged. A reboot often clears it.'));
    }, timeoutMs);

    const done = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(mapOnvifError(err, ctx));
      else resolve(data);
    };

    try {
      if (arg === undefined) fn.call(cam, done);
      else fn.call(cam, arg, done);
    } catch (err) {
      done(err);
    }
  });
}

/** Same as callCam but resolves to `fallback` instead of throwing. */
export async function tryCam(cam, method, arg, fallback = null, opts = {}) {
  try {
    return await callCam(cam, method, arg, opts);
  } catch {
    return fallback;
  }
}

/** ONVIF returns single-element collections as bare objects. Normalize to arrays. */
export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp to [-1, 1] and reject NaN, so a bad client value can never drive PTZ. */
export function normalized(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) {
    throw new AppError('BAD_REQUEST', `"${field}" must be a number between -1 and 1.`);
  }
  return Math.max(-1, Math.min(1, n));
}

export function speed01(value, fallback = 0.5) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map a normalized -1..1 value into a device-reported range. Devices vary wildly:
 * most report -1..1 for pan/tilt, but zoom is frequently 0..1 and some Hikvision
 * PTZ report 0..255 for presets speed.
 */
export function toDeviceRange(value, range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return value;
  const t = (value + 1) / 2; // -1..1 -> 0..1
  return range.min + t * (range.max - range.min);
}

export function fromDeviceRange(value, range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return value;
  if (range.max === range.min) return 0;
  const t = (value - range.min) / (range.max - range.min);
  return t * 2 - 1;
}

/** Inject credentials into a device-supplied URI and pin it to the host we reached. */
export function authorizeUri(uri, { host, port, username, password }) {
  if (!uri) return null;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  // Cameras behind NAT hand back their own LAN address. We can only reach them
  // at the address the operator typed, so rewrite the host but keep the port the
  // device chose (RTSP is usually 554 even when ONVIF is on 80).
  if (parsed.hostname !== host) parsed.hostname = host;
  if (parsed.protocol.startsWith('http') && port) parsed.port = String(port);
  parsed.username = encodeURIComponent(username ?? '');
  parsed.password = encodeURIComponent(password ?? '');
  return parsed.toString();
}

/** Strip credentials from a URI so it is safe to log or return to the browser. */
export function redactUri(uri) {
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
