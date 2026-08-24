import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { buildDigestAuthorization, VATILON_DIGEST_DEFAULTS } from './digest.js';

export const id = 'vatilon';
export const label = 'Vatilon / Sinis';

const LOGIN_PATH = '/cgi-bin/web.cgi?mod=session&cmd=login1';
const CGI_PATH = '/cgi-bin/web.cgi';
const IMAGE_FIELDS = Object.freeze({
  brightness: 'brightness',
  contrast: 'contrast',
  colorSaturation: 'saturation',
  sharpness: 'sharpness',
});
const OPTIONS = Object.freeze({ min: 0, max: 255, step: 1 });

function originFor(host, port) {
  const raw = String(host ?? '').trim();
  if (!raw) throw new AppError('BAD_REQUEST', 'A camera host is required.');
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (port !== undefined && port !== null) url.port = String(port);
    return url.origin;
  }
  const bracketed = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
  return `http://${bracketed}:${port ?? 80}`;
}

/**
 * NOT unref'd. This waits between a write and its read-back, so it is part of an
 * in-flight request rather than a background timer — unref'ing it lets Node exit
 * mid-write and silently abandon the confirmation the caller is awaiting.
 * (The abort timer in fetchTimed IS unref'd; the fetch holds the loop open.)
 */
function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function deviceError(message, hint = null) {
  return new AppError('DEVICE_ERROR', message, hint);
}

function mapNetworkError(error, host) {
  if (error instanceof AppError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new AppError('DEVICE_TIMEOUT', `${host} did not answer in time.`);
  }
  const causeCode = error?.cause?.code ?? error?.code;
  if (['ETIMEDOUT'].includes(causeCode)) {
    return new AppError('DEVICE_TIMEOUT', `${host} did not answer in time.`);
  }
  return new AppError('DEVICE_UNREACHABLE', `Could not reach ${host}.`);
}

async function bodyText(response) {
  try {
    return await response.text();
  } catch {
    throw deviceError('The device returned an unreadable response.');
  }
}

function parseJson(text, operation) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw deviceError(`The device returned an invalid response while ${operation}.`, text.slice(0, 160) || null);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deviceError(`The device returned an invalid response while ${operation}.`);
  }
  if (Object.hasOwn(value, 'status') && value.status !== 'ok') {
    throw deviceError(`The device rejected the request while ${operation}.`);
  }
  return value;
}

function isRejected(response, text = '') {
  return response.status === 401 || response.status === 403 ||
    /session[^a-z]*(expired|invalid|reject)|unauthori[sz]ed/i.test(text);
}

function normalizeImage(raw) {
  const settings = {};
  const options = {};
  for (const [normalized, vendor] of Object.entries(IMAGE_FIELDS)) {
    if (!Object.hasOwn(raw, vendor)) continue;
    const value = Number(raw[vendor]);
    if (!Number.isFinite(value)) continue;
    settings[normalized] = value;
    options[normalized] = { ...OPTIONS };
  }
  return { settings, options };
}

function sameValue(actual, expected) {
  if (typeof expected === 'number') return Number(actual) === expected;
  return Object.is(actual, expected);
}

function createClient(config) {
  const {
    host,
    port = 80,
    username,
    password,
    timeoutMs = 10_000,
    channel = 0,
    fetch: injectedFetch,
    transport,
    digest = {},
    readBackDelays = [150, 400, 900],
  } = config;
  const fetchFn = injectedFetch ?? transport ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new TypeError('A fetch-compatible transport is required.');
  const origin = originFor(host, port);
  let sessionId = null;
  let closed = false;
  let loginPromise = null;

  async function fetchTimed(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetchFn(`${origin}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      throw mapNetworkError(error, host);
    } finally {
      clearTimeout(timer);
    }
  }

  async function login() {
    if (closed) throw new AppError('SESSION_EXPIRED', 'The vendor camera session is closed.');
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const cnonce = randomBytes(16).toString('hex');
      const authorization = buildDigestAuthorization(username, password, {
        ...VATILON_DIGEST_DEFAULTS,
        ...digest,
        cnonce,
      });
      const response = await fetchTimed(LOGIN_PATH, {
        method: 'GET',
        headers: { Authorization: authorization },
      });
      if (response.status === 401 || response.status === 403) {
        throw new AppError('UNAUTHORIZED', 'Device rejected the supplied credentials.');
      }
      if (!response.ok) throw deviceError('The device rejected the vendor login request.');
      const token = response.headers.get('Session-Id');
      if (!token) throw deviceError('The device did not return a vendor session token.');
      sessionId = token;
    })();
    try {
      await loginPromise;
    } finally {
      loginPromise = null;
    }
  }

  async function authenticated(path, init = {}, retry = true) {
    if (!sessionId) await login();
    const response = await fetchTimed(path, {
      ...init,
      headers: { ...(init.headers ?? {}), 'Session-Id': sessionId },
    });
    const text = await bodyText(response);
    if (isRejected(response, text)) {
      if (!retry) throw new AppError('SESSION_EXPIRED', 'The device rejected the vendor session.');
      sessionId = null;
      await login();
      return authenticated(path, init, false);
    }
    if (!response.ok) throw deviceError('The device rejected the vendor CGI request.');
    return text;
  }

  async function readRawImage() {
    const text = await authenticated(`${CGI_PATH}?mod=image&cmd=get`);
    const raw = parseJson(text, 'reading imaging settings');
    if (raw.status === 'ok' && raw.data && typeof raw.data === 'object') return raw.data;
    return raw;
  }

  return {
    login,
    async getImaging() {
      return normalizeImage(await readRawImage());
    },
    async setImaging(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new AppError('BAD_REQUEST', 'Imaging settings must be an object.');
      }
      const unknown = Object.keys(patch).filter((key) => !Object.hasOwn(IMAGE_FIELDS, key));
      if (unknown.length) {
        throw new AppError('BAD_REQUEST', `The vendor driver cannot set imaging field "${unknown[0]}".`);
      }

      const current = await readRawImage();
      const complete = { ...current };
      for (const [normalized, value] of Object.entries(patch)) {
        complete[IMAGE_FIELDS[normalized]] = value;
      }
      const text = await authenticated(CGI_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mod: 'image',
          cmd: 'set',
          param: { channel },
          param2: complete,
        }),
      });
      const result = parseJson(text, 'writing imaging settings');
      if (result.status !== 'ok') throw deviceError('The device rejected the imaging update.');

      // Poll rather than sleeping once. The device does not apply the change
      // synchronously with the response, and a single short delay reports
      // applied:false for a write that did land — which is precisely the lie
      // this driver exists to avoid. Mirrors the ONVIF path in
      // server/onvif/imaging.js.
      let settings = null;
      let applied = {};
      for (const waitMs of readBackDelays) {
        await delay(waitMs);
        settings = normalizeImage(await readRawImage()).settings;
        applied = Object.fromEntries(
          Object.entries(patch).map(([key, expected]) => [key, sameValue(settings[key], expected)]),
        );
        if (Object.values(applied).every(Boolean)) break;
      }
      return { settings, applied };
    },
    close() {
      closed = true;
      sessionId = null;
    },
  };
}

/** Cheap read-only compatibility check. All mismatches intentionally collapse to false. */
export async function probe(config) {
  const client = createClient(config);
  try {
    await client.login();
    const { settings } = await client.getImaging();
    return Object.keys(settings).length > 0;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export async function connect(config) {
  const client = createClient(config);
  try {
    await client.login();
  } catch (error) {
    client.close();
    throw error;
  }
  return { id, getImaging: client.getImaging, setImaging: client.setImaging, close: client.close };
}
