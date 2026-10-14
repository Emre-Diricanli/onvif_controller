// api.js — thin typed-ish wrapper over the API.md wire contract.
//
// Every non-2xx response is parsed for the { error: { code, message, hint } }
// envelope and thrown as an ApiError so views can render the operator-facing
// hint. Never throws a bare Error for a server failure.

export class ApiError extends Error {
  /**
   * @param {string} code     one of the closed set in API.md
   * @param {string} message  always a complete sentence
   * @param {string|null} hint operator-facing remediation sentence
   * @param {number} status   HTTP status, 0 when the request never landed
   */
  constructor(code, message, hint = null, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

async function request(method, path, body, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // keepalive lets a request survive page unload — PTZ stop must land even
      // when the tab is being backgrounded or closed.
      keepalive: opts.keepalive === true,
    });
  } catch {
    throw new ApiError(
      'DEVICE_UNREACHABLE',
      'The controller server did not answer.',
      'Check that the server process is running on this machine.',
      0,
    );
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw new ApiError(
      err.code || 'INTERNAL',
      err.message || `Request failed with status ${res.status}.`,
      err.hint !== undefined ? err.hint : null,
      res.status,
    );
  }
  return data;
}

const get = (path) => request('GET', path);
const post = (path, body, opts) => request('POST', path, body, opts);
const patch = (path, body) => request('PATCH', path, body);
const del = (path) => request('DELETE', path);

const s = (sessionId) => `/api/session/${encodeURIComponent(sessionId)}`;
const q = (params) => {
  const usp = new URLSearchParams(params);
  return `?${usp.toString()}`;
};

export const api = {
  // --- Session ---
  connect: ({ host, port, username, password, protocol = 'auto' }) =>
    post('/api/connect', { host, port, username, password, protocol }),
  listAdapters: () => get('/api/adapters'),

  // --- Settings (protocol-neutral; ADAPTERS.md) ---
  getTargets: (id) => get(`${s(id)}/targets`),
  describeSettings: (id, target) => get(`${s(id)}/settings/describe${q({ target })}`),
  readSettings: (id, target) => get(`${s(id)}/settings${q({ target })}`),
  writeSettings: (id, target, values) => patch(`${s(id)}/settings`, { target, values }),
  getSession: (id) => get(s(id)),
  disconnect: (id) => post(`${s(id)}/disconnect`),
  discover: (timeoutMs = 5000) => post('/api/discover', { timeoutMs }),

  // --- Media ---
  getProfiles: (id) => get(`${s(id)}/profiles`),
  snapshotUrl: (id, profile) => `${s(id)}/snapshot${q({ profile })}`,
  getStreamUrls: (id, credentials = false) =>
    get(`${s(id)}/stream-urls${credentials ? q({ credentials: 'true' }) : ''}`),
  startStream: (id, profile) => post(`${s(id)}/stream/start`, { profile }),
  stopStream: (id, streamId) => post(`${s(id)}/stream/stop`, { streamId }),

  // --- PTZ ---
  ptzMove: (id, profile, { pan = 0, tilt = 0, zoom = 0 }) =>
    post(`${s(id)}/ptz/move`, { profile, pan, tilt, zoom }),
  ptzStop: (id, profile, { panTilt = true, zoom = true } = {}) =>
    // keepalive: a stop issued while the page is being hidden or closed must
    // still reach the camera — a panning camera is a physical hazard.
    post(`${s(id)}/ptz/stop`, { profile, panTilt, zoom }, { keepalive: true }),
  ptzRelative: (id, profile, { pan = 0, tilt = 0, zoom = 0, speed = 0.5 }) =>
    post(`${s(id)}/ptz/relative`, { profile, pan, tilt, zoom, speed }),
  ptzAbsolute: (id, profile, { pan = 0, tilt = 0, zoom = 0, speed = 0.5 }) =>
    post(`${s(id)}/ptz/absolute`, { profile, pan, tilt, zoom, speed }),
  ptzStatus: (id, profile) => get(`${s(id)}/ptz/status${q({ profile })}`),
  getPresets: (id, profile) => get(`${s(id)}/ptz/presets${q({ profile })}`),
  gotoPreset: (id, profile, token, speed = 0.6) =>
    post(`${s(id)}/ptz/presets/goto`, { profile, token, speed }),
  savePreset: (id, profile, name, token = null) =>
    post(`${s(id)}/ptz/presets`, { profile, name, token }),
  deletePreset: (id, profile, token) =>
    del(`${s(id)}/ptz/presets/${encodeURIComponent(token)}${q({ profile })}`),
  ptzHome: (id, profile, action) => post(`${s(id)}/ptz/home`, { profile, action }),
  ptzAux: (id, profile, command) => post(`${s(id)}/ptz/aux`, { profile, command }),

  // --- Imaging ---
  getImaging: (id, profile) => get(`${s(id)}/imaging${q({ profile })}`),
  patchImaging: (id, profile, settings) =>
    patch(`${s(id)}/imaging`, { profile, settings }),
  focus: (id, profile, action, extra = {}) =>
    post(`${s(id)}/imaging/focus`, { profile, action, ...extra }),

  // --- Device ---
  getDevice: (id) => get(`${s(id)}/device`),
  setRelay: (id, token, state) => post(`${s(id)}/device/relay`, { token, state }),
  reboot: (id) => post(`${s(id)}/device/reboot`),
  syncTime: (id) => post(`${s(id)}/device/synctime`),

  // --- Playback (ONVIF Profile G) — read-only probe ---
  getPlayback: (id) => get(`${s(id)}/playback`),

  // --- Fan-out (server-wide, not session-scoped) ---
  getFanout: () => get('/api/fanout'),
  testFanout: (targetId) => post('/api/fanout/test', { id: targetId }),
};

/** Absolute WebSocket URL for a contract path (same origin). */
export function wsUrl(path, params) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const usp = new URLSearchParams(params);
  return `${proto}//${window.location.host}${path}?${usp.toString()}`;
}
