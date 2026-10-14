/**
 * ControllerClient: the controller's REST API (API.md) as methods (MCP.md §5).
 *
 * Responses are bounded, deadlines include body reads, and failures never retry
 * a request: a write may already have reached the camera.
 */

import { validateConfig } from './config.js';
import { scrub } from './kit.js';

export const MAX_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Preserve ONVIF resource tokens, but remove credentials and URL userinfo. */
function safeValue(value) {
  if (typeof value === 'string') {
    return value.replace(/(rtsps?|https?):\/\/[^\s/@]*@/gi, '$1://***@')
      .replace(/([?&](?:token|password|access_token|auth)=)[^&#\s]*/gi, '$1***');
  }
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
      /^(password|passwd|pwd|authorization|access_token|refresh_token)$/i.test(key) ? '***' : safeValue(v)]));
  }
  return value;
}

async function readBounded(res, limit) {
  const tooLarge = () => new ControllerError('CONTROLLER_RESPONSE_TOO_LARGE', 'Controller response exceeded the size limit.', null, res.status);
  if (Number(res.headers.get('content-length')) > limit) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, size);
}

export class ControllerError extends Error {
  constructor(code, message, hint = null, status = 0) {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

const enc = encodeURIComponent;
const qs = (params) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) usp.set(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export class ControllerClient {
  #passwords = new Set();

  constructor({ name, url, token = null, timeoutMs = 30_000 }) {
    validateConfig({ controllers: [{ name, url, token, timeoutMs }] }, { resolveEnvironment: false });
    this.name = name;
    this.base = String(url).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, { binary = false, timeoutMs } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const signal = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method, headers, redirect: 'manual',
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
      if (res.status === 401) {
        await res.body?.cancel();
        throw new ControllerError('CONTROLLER_UNAUTHORIZED', 'Controller authentication failed.',
          'Check the controller token in MCP config matches CONTROLLER_TOKEN on the controller.', 401);
      }
      if (res.status === 204) return null;
      const buffer = await readBounded(res, binary && res.ok ? MAX_IMAGE_BYTES : MAX_JSON_BYTES);
      if (binary && res.ok) return { buffer, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
      let envelope;
      try { envelope = buffer.length ? JSON.parse(buffer.toString('utf8')) : null; } catch {
        throw new ControllerError('CONTROLLER_INVALID_RESPONSE', 'Controller returned invalid JSON.', null, res.status);
      }
      if (!res.ok) {
        const e = envelope?.error ?? {};
        /** Do not trust upstream diagnostics to keep bearer or camera secrets private. */
        const sensitive = [this.token, ...this.#passwords, body?.password, body?.username].filter(Boolean);
        const safe = (value, fallback) => {
          if (typeof value !== 'string' || sensitive.some((secret) => value.includes(secret))) return fallback;
          return scrub(value);
        };
        const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)
          && !sensitive.includes(e.code) ? e.code : `HTTP_${res.status}`;
        throw new ControllerError(code, safe(e.message, `Controller answered HTTP ${res.status}.`), safe(e.hint, null), res.status);
      }
      return safeValue(envelope);
    } catch (err) {
      if (err instanceof ControllerError) throw err;
      const timedOut = signal.aborted || err?.name === 'TimeoutError';
      throw new ControllerError(timedOut ? 'CONTROLLER_TIMEOUT' : 'CONTROLLER_UNREACHABLE',
        timedOut ? 'Controller did not answer in time.' : 'Controller could not be reached.',
        'Check that the controller is running and reachable.');
    }
  }

  s(id) { return `/api/session/${enc(id)}`; }

  health() { return this.request('GET', '/api/health'); }
  adapters() { return this.request('GET', '/api/adapters'); }
  discover(timeoutMs = 5000) { return this.request('POST', '/api/discover', { timeoutMs }, { timeoutMs: timeoutMs + 10_000 }); }
  connect({ host, port = 80, username, password, protocol = 'auto' }) {
    if (password) this.#passwords.add(password);
    return this.request('POST', '/api/connect', { host, port, username, password, protocol }, { timeoutMs: 90_000 });
  }
  session(id) { return this.request('GET', this.s(id)); }
  disconnect(id) { return this.request('POST', `${this.s(id)}/disconnect`); }

  profiles(id) { return this.request('GET', `${this.s(id)}/profiles`); }
  snapshot(id, profile) { return this.request('GET', `${this.s(id)}/snapshot${qs({ profile })}`, undefined, { binary: true }); }
  streamUrls(id) { return this.request('GET', `${this.s(id)}/stream-urls`); }

  targets(id) { return this.request('GET', `${this.s(id)}/targets`); }
  describeSettings(id, target) { return this.request('GET', `${this.s(id)}/settings/describe${qs({ target })}`); }
  readSettings(id, target, keys) { return this.request('GET', `${this.s(id)}/settings${qs({ target, keys: keys?.length ? keys.join(',') : undefined })}`); }
  writeSettings(id, target, values) { return this.request('PATCH', `${this.s(id)}/settings`, { target, values }, { timeoutMs: 60_000 }); }

  imaging(id, profile) { return this.request('GET', `${this.s(id)}/imaging${qs({ profile })}`); }
  writeImaging(id, profile, settings) { return this.request('PATCH', `${this.s(id)}/imaging`, { profile, settings }, { timeoutMs: 60_000 }); }
  focus(id, profile, body) { return this.request('POST', `${this.s(id)}/imaging/focus`, { profile, ...body }); }

  encoder(id, profile) { return this.request('GET', `${this.s(id)}/encoder${qs({ profile })}`); }
  writeEncoder(id, profile, settings) { return this.request('PATCH', `${this.s(id)}/encoder`, { profile, settings }, { timeoutMs: 60_000 }); }

  network(id) { return this.request('GET', `${this.s(id)}/network`); }
  writeNetwork(id, patch) { return this.request('PATCH', `${this.s(id)}/network`, patch, { timeoutMs: 60_000 }); }

  device(id) { return this.request('GET', `${this.s(id)}/device`); }
  reboot(id) { return this.request('POST', `${this.s(id)}/device/reboot`); }
  syncTime(id) { return this.request('POST', `${this.s(id)}/device/synctime`); }
  setRelay(id, { token, state }) { return this.request('POST', `${this.s(id)}/device/relay`, { token, state }); }

  ptzMove(id, { profile, pan = 0, tilt = 0, zoom = 0 }) { return this.request('POST', `${this.s(id)}/ptz/move`, { profile, pan, tilt, zoom }); }
  ptzStop(id, { profile, panTilt = true, zoom = true }) { return this.request('POST', `${this.s(id)}/ptz/stop`, { profile, panTilt, zoom }); }
  ptzRelative(id, body) { return this.request('POST', `${this.s(id)}/ptz/relative`, body); }
  ptzAbsolute(id, body) { return this.request('POST', `${this.s(id)}/ptz/absolute`, body); }
  ptzStatus(id, profile) { return this.request('GET', `${this.s(id)}/ptz/status${qs({ profile })}`); }
  ptzPresets(id, profile) { return this.request('GET', `${this.s(id)}/ptz/presets${qs({ profile })}`); }
  ptzGotoPreset(id, { profile, token, speed }) { return this.request('POST', `${this.s(id)}/ptz/presets/goto`, { profile, token, speed }); }
  ptzSavePreset(id, { profile, name, token }) { return this.request('POST', `${this.s(id)}/ptz/presets`, { profile, name, token }); }
  ptzDeletePreset(id, profile, token) { return this.request('DELETE', `${this.s(id)}/ptz/presets/${enc(token)}${qs({ profile })}`); }
  ptzHome(id, { profile, action = 'goto' }) { return this.request('POST', `${this.s(id)}/ptz/home`, { profile, action }); }
}
