// Verification: mock-verified (personas reolink-rlc810, reolink-nvr)
/**
 * Reolink JSON CGI adapter (ADAPTERS.md §5).
 *
 * Reolink cameras and NVRs speak a token-based JSON CGI API: POST a JSON array
 * like [{"cmd":"GetImage","action":0,"param":{...}}] to
 * /cgi-bin/api.cgi?cmd=<Cmd>&token=<token> and read a JSON array back. The
 * adapter does its own login (auth:'none' at the transport — the token travels
 * in the query string, so a request path must never reach a log line or an
 * error message) and transparently re-logins once when a request comes back
 * with the "please login!" token-expiry signature.
 *
 * Imaging lives in two native objects per channel (Image, Isp); the encoder
 * config lives in one (Enc), and the device insists on receiving Enc whole —
 * so an encoder write is a read-modify-write of the entire object even when
 * only one field of one stream changed. Locks are per (device, resource)
 * where a resource is one native object on one channel, so a write to
 * channel 2 can never touch channel 1's object.
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, verifyWrite } from '../../settings/contract.js';

export const id = 'reolink';
export const label = 'Reolink HTTP API';
export const priority = 35;
export const defaultPorts = [80];

const API = '/cgi-bin/api.cgi';

// Native spellings assumed from vendor docs, not hardware-verified (the
// personas are the authority).
const DAY_NIGHT_TO_NATIVE = Object.freeze({ auto: 'Auto', day: 'Color', night: 'Black&White' });
const DAY_NIGHT_TO_CANON = Object.freeze({ Auto: 'auto', Color: 'day', 'Black&White': 'night' });
const CODEC_TO_NATIVE = Object.freeze({ 'H.264': 'h264', 'H.265': 'h265' });
const CODEC_TO_CANON = Object.freeze({ h264: 'H.264', h265: 'H.265' });

const intField = (label, native, range) => ({
  label,
  group: 'imaging',
  type: 'int',
  unit: null,
  ...(range ? { min: range[0], max: range[1], step: 1 } : {}),
  get: (o) => o[native],
  set: (o, v) => { o[native] = v; },
});

const boolField = (label, native) => ({
  label,
  group: 'imaging',
  type: 'bool',
  unit: null,
  get: (o) => Boolean(o[native]),
  set: (o, v) => { o[native] = Boolean(v); },
});

// Reolink documents a fixed 0..255 range for every Image field, and §3 allows
// declaring a vendor-documented fixed range without asking the device.
// assumed from vendor docs, not hardware-verified.
const RANGE_0_255 = [0, 255];
const IMAGE_FIELDS = Object.freeze({
  'image.brightness': intField('Brightness', 'bright', RANGE_0_255),
  'image.contrast': intField('Contrast', 'contrast', RANGE_0_255),
  'image.saturation': intField('Saturation', 'saturation', RANGE_0_255),
  'image.sharpness': intField('Sharpness', 'sharpen', RANGE_0_255),
  'vendor.reolink.hue': intField('Hue', 'hue', RANGE_0_255),
});

const ISP_FIELDS = Object.freeze({
  'image.dayNight': {
    label: 'Day/Night',
    group: 'imaging',
    type: 'enum',
    unit: null,
    values: Object.keys(DAY_NIGHT_TO_NATIVE),
    get: (o) => DAY_NIGHT_TO_CANON[o.dayNight] ?? null,
    set: (o, v) => { o.dayNight = DAY_NIGHT_TO_NATIVE[v]; },
  },
  'image.mirror': boolField('Mirror', 'mirroring'),
  'image.flip': boolField('Flip', 'rotation'),
});

// Encoder settings hang under Enc.mainStream / Enc.subStream. SetEnc must be
// sent the whole Enc object, so a write deep-copies what GetEnc returned and
// changes only the requested fields.
function encFields(streamKey) {
  const field = (label, native, extra = {}) => ({
    label,
    group: 'encoder',
    type: 'int',
    unit: null,
    ...extra,
    get: (o) => o[streamKey]?.[native],
    set: (o, v) => { o[streamKey][native] = v; },
  });
  return {
    'video.codec': {
      label: 'Codec',
      group: 'encoder',
      type: 'enum',
      unit: null,
      values: Object.keys(CODEC_TO_NATIVE),
      get: (o) => CODEC_TO_CANON[o[streamKey]?.vType] ?? null,
      set: (o, v) => { o[streamKey].vType = CODEC_TO_NATIVE[v]; },
    },
    'video.resolution': {
      // The device reports the current size as '2560*1440' but no candidate
      // list, so per §3 the descriptor is a plain string, not an enum of
      // guessed values.
      label: 'Resolution',
      group: 'encoder',
      type: 'string',
      unit: null,
      get: (o) => (o[streamKey]?.size == null ? null : String(o[streamKey].size).replace('*', 'x')),
      set: (o, v) => { o[streamKey].size = String(v).replace('x', '*'); },
    },
    // Reolink bitRate is already kbps — assumed from vendor docs, not
    // hardware-verified.
    'video.fps': field('Frame rate', 'frameRate', { unit: 'fps' }),
    'video.bitrate': field('Bitrate', 'bitRate', { unit: 'kbps' }),
    'video.gop': field('GOP', 'gop'),
  };
}

// One resource = one native object on one channel = one lock key.
const RESOURCES = Object.freeze({
  image: { getCmd: 'GetImage', setCmd: 'SetImage', wrap: 'Image' },
  isp: { getCmd: 'GetIsp', setCmd: 'SetIsp', wrap: 'Isp' },
  enc: { getCmd: 'GetEnc', setCmd: 'SetEnc', wrap: 'Enc' },
});

function parseResource(resource) {
  const sep = resource.lastIndexOf(':');
  return { kind: resource.slice(0, sep), channel: Number(resource.slice(sep + 1)) };
}

function fieldsFor(kind, streamKey) {
  if (kind === 'image') return IMAGE_FIELDS;
  if (kind === 'isp') return ISP_FIELDS;
  return encFields(streamKey);
}

function toDescriptor(key, def, resource) {
  const d = {
    key,
    label: def.label,
    group: def.group,
    type: def.type,
    unit: def.unit ?? null,
    writable: true,
    resource,
  };
  if (def.min !== undefined) {
    d.min = def.min;
    d.max = def.max;
    d.step = def.step ?? 1;
  }
  if (def.type === 'enum') d.values = [...def.values];
  return d;
}

/**
 * One CGI exchange. The token is in the query string, so the path must never
 * be put in an error message or a log line (§7) — errors here name the
 * operation and the host, never the URL.
 */
async function rawRequest(client, host, cmd, param, token) {
  const query = token ? `?cmd=${cmd}&token=${encodeURIComponent(token)}` : `?cmd=${cmd}`;
  const res = await client.request({
    method: 'POST',
    path: `${API}${query}`,
    body: [{ cmd, action: 0, param }],
  });
  let body;
  try {
    body = res.json();
  } catch {
    throw new AppError('DEVICE_ERROR', `${host} returned a non-JSON response.`);
  }
  if (!Array.isArray(body) || !body[0] || typeof body[0].code !== 'number') {
    throw new AppError('DEVICE_ERROR', `${host} returned an unexpected response.`);
  }
  return body;
}

// The token-expiry signature: code 1 with rspCode -6 or "please login!".
function isLoginError(body) {
  const err = body?.[0]?.error;
  return body?.[0]?.code === 1 && (err?.rspCode === -6 || /please login/i.test(err?.detail ?? ''));
}

/**
 * Login + token bookkeeping for one connection. A request that comes back
 * "please login!" triggers exactly one re-login and retry; a second rejection
 * is the device's answer and surfaces as DEVICE_ERROR rather than looping.
 */
function makeSession(config, client) {
  const { host, username, password } = config;
  let token = null;

  async function login() {
    const body = await rawRequest(client, host, 'Login', { User: { userName: username, password } }, null);
    const first = body[0];
    if (first.code === 0 && first.value?.Token?.name) {
      token = first.value.Token.name;
      return;
    }
    if (first.code === 1 && first.error?.rspCode === -111) {
      throw new AppError('UNAUTHORIZED', `${host} rejected the credentials.`);
    }
    throw new AppError('DEVICE_ERROR', `${host} rejected the login request.`);
  }

  async function call(cmd, param) {
    let body = await rawRequest(client, host, cmd, param, token);
    if (isLoginError(body)) {
      await login();
      body = await rawRequest(client, host, cmd, param, token);
      if (isLoginError(body)) {
        throw new AppError('DEVICE_ERROR', `${host} keeps rejecting the session token.`);
      }
    }
    return body;
  }

  async function getNative(kind, channel) {
    const { getCmd, wrap } = RESOURCES[kind];
    const body = await call(getCmd, { channel });
    if (body[0].code !== 0) {
      throw new AppError('DEVICE_ERROR', `${host} rejected ${getCmd} (code ${body[0].code}).`);
    }
    const obj = body[0].value?.[wrap];
    if (!obj || typeof obj !== 'object') {
      throw new AppError('DEVICE_ERROR', `${host} returned no ${wrap} object.`);
    }
    // Deep copy: the caller mutates this before Set*, and the live response
    // object must not leak between channels.
    return JSON.parse(JSON.stringify(obj));
  }

  async function setNative(kind, channel, obj) {
    const { setCmd, wrap } = RESOURCES[kind];
    return call(setCmd, { [wrap]: { ...obj, channel } });
  }

  return { login, call, getNative, setNative };
}

/**
 * Cheap, read-only, never throws (§5). A login that fails still identifies a
 * Reolink box — the error array with error.rspCode is the vendor's shape,
 * unlike a 404 server's HTML — but a plain 404 that happens to parse as
 * nothing must not match. At most 2 requests.
 */
export async function probe(config) {
  const client = createHttpClient({ ...config, auth: 'none', timeoutMs: config.timeoutMs ?? 3000 });
  try {
    const login = await rawRequest(client, config.host, 'Login', {
      User: { userName: config.username ?? '', password: config.password ?? '' },
    }, null);
    const first = login[0];
    if (first.cmd !== 'Login' || typeof first.code !== 'number') return { match: false, confidence: 0 };
    if (first.code !== 0) {
      // A wrong password on a Reolink device still proves the vendor.
      return first.error && typeof first.error.rspCode === 'number'
        ? { match: true, confidence: 0.6 }
        : { match: false, confidence: 0 };
    }
    const token = first.value?.Token?.name;
    if (!token) return { match: false, confidence: 0 };
    const info = await rawRequest(client, config.host, 'GetDevInfo', { command: 'GetDevInfo' }, token);
    const dev = info[0]?.value?.DevInfo;
    if (info[0]?.code === 0 && dev && typeof dev === 'object' && (dev.model || dev.type)) {
      return {
        match: true,
        confidence: 0.95,
        model: dev.model ?? String(dev.type),
        ...(dev.firmVersion ? { firmware: dev.firmVersion } : {}),
      };
    }
    return { match: false, confidence: 0 };
  } catch {
    return { match: false, confidence: 0 };
  } finally {
    client.close();
  }
}

export async function connect(config) {
  const client = createHttpClient({ ...config, auth: 'none' });
  const session = makeSession(config, client);
  let closed = false;
  let targets = null;
  const descriptorCache = new Map();

  await session.login();

  let info = { vendor: 'Reolink', model: null, firmware: null, serial: null };
  try {
    const body = await session.call('GetDevInfo', { command: 'GetDevInfo' });
    const dev = body[0].code === 0 ? body[0].value?.DevInfo : null;
    if (dev && typeof dev === 'object') {
      info = {
        vendor: 'Reolink',
        model: dev.model ?? (dev.type ? String(dev.type) : null),
        firmware: dev.firmVersion ?? null,
        serial: null,
      };
    }
  } catch {
    // Login already proved the API; a DevInfo miss must not block the session.
  }

  async function listTargets() {
    if (targets) return targets;
    const body = await session.call('GetChannelstatus', {});
    const status = body[0].code === 0 ? body[0].value?.status : null;
    if (!Array.isArray(status)) {
      throw new AppError('DEVICE_ERROR', `${config.host} returned no channel status.`);
    }
    const out = [];
    for (const entry of status) {
      const native = Number(entry?.channel);
      if (!Number.isInteger(native)) continue;
      const c = native + 1; // operator channel is 1-based; native is 0-based
      out.push({ id: `channel:${c}`, scope: 'channel', label: entry.name || `Channel ${c}`, channel: c });
      // streamKey is adapter-internal: which half of the Enc object this target maps to.
      out.push({ id: `stream:${c}.main`, scope: 'stream', label: 'Main stream', channel: c, parent: `channel:${c}`, streamKey: 'mainStream' });
      out.push({ id: `stream:${c}.sub`, scope: 'stream', label: 'Sub stream', channel: c, parent: `channel:${c}`, streamKey: 'subStream' });
    }
    targets = out;
    return out;
  }

  async function requireTarget(targetId) {
    const all = await listTargets();
    const t = all.find((x) => x.id === targetId);
    if (!t) throw new AppError('NOT_FOUND', `No target "${targetId}".`);
    return t;
  }

  async function describeSettings(targetId) {
    const t = await requireTarget(targetId);
    if (descriptorCache.has(t.id)) return descriptorCache.get(t.id);
    const n = t.channel - 1;
    let defs;
    if (t.scope === 'channel') {
      defs = [
        ...Object.entries(IMAGE_FIELDS).map(([k, f]) => toDescriptor(k, f, `image:${n}`)),
        ...Object.entries(ISP_FIELDS).map(([k, f]) => toDescriptor(k, f, `isp:${n}`)),
      ];
    } else if (t.scope === 'stream') {
      defs = Object.entries(encFields(t.streamKey)).map(([k, f]) => toDescriptor(k, f, `enc:${n}`));
    } else {
      defs = [];
    }
    descriptorCache.set(t.id, defs);
    return defs;
  }

  async function read(targetId, keys) {
    const t = await requireTarget(targetId);
    const defs = await describeSettings(targetId);
    const wanted = keys ? new Set(keys) : null;
    const byResource = new Map();
    for (const d of defs) {
      if (wanted && !wanted.has(d.key)) continue;
      if (!byResource.has(d.resource)) byResource.set(d.resource, []);
      byResource.get(d.resource).push(d);
    }
    const values = {};
    for (const [resource, ds] of byResource) {
      const { kind, channel } = parseResource(resource);
      const fields = fieldsFor(kind, t.streamKey);
      const obj = await session.getNative(kind, channel);
      for (const d of ds) values[d.key] = fields[d.key].get(obj);
    }
    return { values, source: 'reolink' };
  }

  async function write(targetId, patch) {
    const t = await requireTarget(targetId);
    const defs = await describeSettings(targetId);
    // Throws BAD_REQUEST before anything reaches the wire.
    const used = validatePatch(patch, defs);

    // Group by native resource; each group is its own read-modify-write under
    // its own lock, so channel N's objects are never read or written while
    // serving a patch for channel M.
    const groups = new Map();
    for (const [key] of Object.entries(patch)) {
      const resource = used[key].resource;
      if (!groups.has(resource)) groups.set(resource, []);
      groups.get(resource).push(key);
    }

    const before = {};
    const rejected = [];
    for (const [resource, groupKeys] of groups) {
      await withResourceLock(lockKey(config.host, config.port, resource), async () => {
        const { kind, channel } = parseResource(resource);
        const fields = fieldsFor(kind, t.streamKey);
        const current = await session.getNative(kind, channel);
        for (const key of groupKeys) before[key] = fields[key].get(current);
        for (const key of groupKeys) fields[key].set(current, patch[key]);
        const body = await session.setNative(kind, channel, current);
        // A vendor error body on Set* is a per-field refusal, not a transport
        // failure: those keys report 'rejected', nothing is thrown.
        if (body[0].code !== 0) rejected.push(...groupKeys);
      });
    }

    return verifyWrite({
      patch,
      before,
      descriptors: used,
      rejected,
      source: 'reolink',
      readBack: async () => (await read(targetId, Object.keys(patch))).values,
    });
  }

  return {
    id: 'reolink',
    label,
    info,
    listTargets,
    describeSettings,
    read,
    write,
    close() {
      if (closed) return;
      closed = true;
      client.close();
    },
  };
}
