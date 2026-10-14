/**
 * ControllerClient: the controller's REST API (API.md) as methods (MCP.md §5).
 *
 * Step-0 reference implementation. The interface is frozen; Stream 2 owns
 * hardening (retries on connection reset, response size bounds, TLS options).
 */

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
  constructor({ name, url, token = null, timeoutMs = 30_000 }) {
    if (!url) throw new Error(`Controller "${name}" has no url`);
    this.name = name;
    this.base = String(url).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, { binary = false, timeoutMs } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      throw new ControllerError(timedOut ? 'CONTROLLER_TIMEOUT' : 'CONTROLLER_UNREACHABLE',
        `Controller "${this.name}" ${timedOut ? 'did not answer in time' : 'could not be reached'}.`,
        `Check that it is running and reachable at ${this.base}.`);
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      let envelope = null;
      try { envelope = await res.json(); } catch { /* not JSON */ }
      const e = envelope?.error ?? {};
      throw new ControllerError(e.code ?? `HTTP_${res.status}`, e.message ?? `Controller answered HTTP ${res.status}.`, e.hint ?? null, res.status);
    }
    if (binary) return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    const textBody = await res.text();
    return textBody ? JSON.parse(textBody) : null;
  }

  s(id) { return `/api/session/${enc(id)}`; }

  health() { return this.request('GET', '/api/health'); }
  adapters() { return this.request('GET', '/api/adapters'); }
  discover(timeoutMs = 5000) { return this.request('POST', '/api/discover', { timeoutMs }, { timeoutMs: timeoutMs + 10_000 }); }
  connect({ host, port = 80, username, password, protocol = 'auto' }) {
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
