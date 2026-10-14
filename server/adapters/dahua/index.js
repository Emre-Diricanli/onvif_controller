// Verification: mock-verified (personas dahua-ipc, lorex-n864)
/**
 * Dahua / Lorex HTTP API (CGI) adapter (ADAPTERS.md §5).
 *
 * Dahua cameras and recorders — and the OEM boxes built on the same firmware
 * (Lorex, Amcrest, ...) — expose a text CGI API under /cgi-bin/:
 *
 *   magicBox.cgi?action=getDeviceType        -> type=IPC-HDW2431T-AS-S2
 *   magicBox.cgi?action=getSoftwareVersion   -> version=2.800.0000000.25.R,build:...
 *   magicBox.cgi?action=getProductDefinition -> table.VideoInputChannels=1 ...
 *   configManager.cgi?action=getConfig&name=VideoColor
 *                                            -> table.VideoColor[0][0].Brightness=50 ...
 *   configManager.cgi?action=setConfig&VideoColor[0][0].Brightness=60
 *                                            -> OK   (or: Error\r\nBad Request!)
 *
 * Authentication is RFC 2617 Digest (qop=auth), which the governed transport
 * answers with auth:'auto'. The JSON RPC2 API with its session login is a
 * different surface and is not used here.
 *
 * setConfig is natively PARTIAL: it takes only the paths it is given and
 * leaves the rest of the table alone, so a write sends exactly the requested
 * fields — never the unchanged remainder of the object. A bare "OK" still
 * proves nothing (VENDOR.md): every write is confirmed by read-back through
 * verifyWrite(). A body starting with "Error" (usually HTTP 400) refuses every
 * field in that request; firmware does not say which field, so the whole
 * resource group is reported `rejected`.
 *
 * Native channel indexes are 0-based (`VideoColor[0]`); the operator-facing
 * `channel` label is 1-based. Target ids: `channel:<n>` (imaging),
 * `stream:<n>:main` / `stream:<n>:sub` (encoder; MainFormat[0] / ExtraFormat[0]).
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, verifyWrite } from '../../settings/contract.js';
import { parseKeyValue, parseTable, isErrorBody } from './kv.js';

export const id = 'dahua';
export const label = 'Dahua / Lorex HTTP API';
export const priority = 30;
export const defaultPorts = [80];

const MAGIC_BOX = '/cgi-bin/magicBox.cgi';
const CONFIG = '/cgi-bin/configManager.cgi';

// A hard ceiling on channel counts read from the device: a garbled product
// definition must not make us enumerate thousands of targets.
const MAX_CHANNELS = 256;

const toInt = (raw) => {
  if (raw === undefined || !/^\s*-?\d+\s*$/.test(raw)) return undefined;
  return Number.parseInt(raw, 10);
};
const toNumber = (raw) => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};
const toBool = (raw) => {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
};
const invert = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k])));

// VideoInOptions.DayNightColor: 0 = always colour, 1 = auto (by brightness),
// 2 = always black & white. assumed from vendor docs, not hardware-verified.
const DAY_NIGHT_TO_NATIVE = Object.freeze({ auto: '1', day: '0', night: '2' });
const DAY_NIGHT_TO_CANON = invert(DAY_NIGHT_TO_NATIVE);
// Dahua spells Motion-JPEG "MJPG". Other native values (e.g. "MPEG4",
// "H.264H" on old firmware) read as null rather than being guessed.
const CODEC_TO_NATIVE = Object.freeze({ 'H.264': 'H.264', 'H.265': 'H.265', MJPEG: 'MJPG' });
const CODEC_TO_CANON = invert(CODEC_TO_NATIVE);
const RATE_TO_NATIVE = Object.freeze({ cbr: 'CBR', vbr: 'VBR' });
const RATE_TO_CANON = invert(RATE_TO_NATIVE);

// Dahua documents a fixed 0..100 range for the colour and sharpness controls,
// so §3 lets us declare it without asking the device. assumed from vendor
// docs, not hardware-verified.
const PERCENT = Object.freeze({ min: 0, max: 100, step: 1 });

const int = (label, table, leaf, extra = {}) => ({
  label, type: 'int', unit: null, table, leaves: [leaf], ...extra,
  decode: ([raw]) => toInt(raw),
  encode: (v) => [String(v)],
});
const bool = (label, table, leaf) => ({
  label, type: 'bool', unit: null, table, leaves: [leaf],
  decode: ([raw]) => toBool(raw),
  encode: (v) => [v ? 'true' : 'false'],
});
const enumField = (label, table, leaf, toNative, toCanon) => ({
  label, type: 'enum', unit: null, values: Object.keys(toNative), table, leaves: [leaf],
  decode: ([raw]) => toCanon[String(raw ?? '').trim()] ?? null,
  encode: (v) => [toNative[v]],
});

/**
 * Imaging fields of one channel. VideoColor and VideoInSharpness are indexed
 * [channel][section]: Dahua keeps up to three time-section profiles (normal /
 * day / night) per channel and the live image uses section 0 unless the
 * operator configured a profile schedule — so the adapter reads and writes
 * section 0 only. assumed from vendor docs, not hardware-verified.
 * Sharpness lives in its own table (VideoInSharpness), not in VideoColor;
 * a device without that table simply does not get the descriptor.
 */
const CHANNEL_FIELDS = Object.freeze({
  'image.brightness': int('Brightness', 'VideoColor', 'Brightness', PERCENT),
  'image.contrast': int('Contrast', 'VideoColor', 'Contrast', PERCENT),
  'image.saturation': int('Saturation', 'VideoColor', 'Saturation', PERCENT),
  'image.sharpness': int('Sharpness', 'VideoInSharpness', 'Sharpness', PERCENT),
  'image.dayNight': enumField('Day/Night', 'VideoInOptions', 'DayNightColor', DAY_NIGHT_TO_NATIVE, DAY_NIGHT_TO_CANON),
  'image.mirror': bool('Mirror', 'VideoInOptions', 'Mirror'),
  'image.flip': bool('Flip', 'VideoInOptions', 'Flip'),
});

/**
 * Encoder fields of one stream (Encode[ch].MainFormat[0].Video.* or
 * ExtraFormat[0].Video.*). BitRate is already kbps on Dahua, so no rescale.
 * No fps/bitrate/gop range is declared: the per-stream limits come from
 * encode.cgi?action=getConfigCaps, whose shape varies by firmware, and a
 * guessed range is worse than none (§3).
 */
const STREAM_FIELDS = Object.freeze({
  'video.codec': enumField('Codec', 'Encode', 'Compression', CODEC_TO_NATIVE, CODEC_TO_CANON),
  'video.resolution': {
    // Width and Height are two native params but one operator setting, so
    // they are read and written together. The device reports only the current
    // size, not the list it accepts, so this is a 'string' "WxH" rather than
    // an enum of guessed values; the device's own Error answer refuses a size
    // it does not support.
    label: 'Resolution', type: 'string', unit: null, table: 'Encode', leaves: ['Width', 'Height'],
    decode: ([w, h]) => {
      const width = toInt(w);
      const height = toInt(h);
      return width === undefined || height === undefined ? undefined : `${width}x${height}`;
    },
    encode: (v) => v.split('x'),
  },
  'video.fps': {
    label: 'Frame rate', type: 'number', unit: 'fps', table: 'Encode', leaves: ['FPS'],
    decode: ([raw]) => toNumber(raw),
    encode: (v) => [String(v)],
  },
  'video.bitrateMode': enumField('Bitrate control', 'Encode', 'BitRateControl', RATE_TO_NATIVE, RATE_TO_CANON),
  'video.bitrate': int('Bitrate', 'Encode', 'BitRate', { unit: 'kbps' }),
  'video.gop': int('GOP', 'Encode', 'GOP'),
});

const RESOLUTION_RE = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/;

/** Native path prefix of a field's table for one channel/stream. */
function prefixFor(table, ch, stream) {
  switch (table) {
    case 'VideoColor': return `VideoColor[${ch}][0].`;
    case 'VideoInSharpness': return `VideoInSharpness[${ch}][0].`;
    case 'VideoInOptions': return `VideoInOptions[${ch}].`;
    case 'Encode': return `Encode[${ch}].${stream === 'sub' ? 'ExtraFormat' : 'MainFormat'}[0].Video.`;
    default: throw new Error(`unknown Dahua table ${table}`);
  }
}

/** One lock per native object: a channel's table section, or one stream's format. */
function resourceFor(table, ch, stream) {
  return table === 'Encode' ? `Encode:${ch}:${stream}` : `${table}:${ch}`;
}

const pathsOf = (field, ch, stream) => field.leaves.map((leaf) => `${prefixFor(field.table, ch, stream)}${leaf}`);

function decodeField(field, table, ch, stream) {
  const raws = pathsOf(field, ch, stream).map((p) => table.get(p));
  if (raws.some((r) => r === undefined)) return undefined;
  return field.decode(raws);
}

function toDescriptor(key, field, ch, stream) {
  const d = {
    key,
    label: field.label,
    group: field.table === 'Encode' ? 'encoder' : 'imaging',
    type: field.type,
    unit: field.unit ?? null,
    writable: true,
    resource: resourceFor(field.table, ch, stream),
  };
  if (field.min !== undefined) Object.assign(d, { min: field.min, max: field.max, step: field.step });
  if (field.type === 'enum') d.values = [...field.values];
  return d;
}

/**
 * Brackets are sent literally: Dahua firmware matches the setConfig path
 * textually, and several builds do not decode %5B/%5D in the key. Values are
 * percent-encoded. assumed from vendor docs, not hardware-verified.
 */
function setConfigQuery(pairs) {
  return pairs.map(([path, value]) => `${path}=${encodeURIComponent(value)}`).join('&');
}

async function magicBox(client, action) {
  const res = await client.request({ path: `${MAGIC_BOX}?action=${action}` });
  if (res.status !== 200 || isErrorBody(res.text)) return null;
  return parseKeyValue(res.text);
}

/** `type=<model>` on a line of its own: the Dahua getDeviceType body shape. */
function deviceTypeOf(kv) {
  const type = kv?.get('type');
  return typeof type === 'string' && type.trim() ? type.trim() : null;
}

/**
 * Cheap, read-only, never throws (§5). Matches on the getDeviceType BODY
 * shape — a `type=` line under /cgi-bin/magicBox.cgi — never on a status
 * code: a 401 alone proves only that something wants credentials, and a plain
 * 404 server or another vendor's CGI does not answer with that line. At most
 * three exchanges: the Digest challenge, getDeviceType, getSoftwareVersion.
 */
export async function probe(config) {
  let client;
  try {
    client = createHttpClient({ ...config, auth: 'auto', timeoutMs: config.timeoutMs ?? 3000 });
    const type = deviceTypeOf(await magicBox(client, 'getDeviceType'));
    if (!type) return { match: false, confidence: 0 };
    let firmware;
    try {
      firmware = (await magicBox(client, 'getSoftwareVersion'))?.get('version')?.trim() || undefined;
    } catch {
      firmware = undefined;
    }
    return { match: true, confidence: firmware ? 0.95 : 0.85, model: type, ...(firmware ? { firmware } : {}) };
  } catch {
    // Wrong credentials, unreachable host, timeout — all collapse to no-match.
    return { match: false, confidence: 0 };
  } finally {
    try { client?.close(); } catch { /* never throws */ }
  }
}

export async function connect(config) {
  const { host, port } = config;
  const client = createHttpClient({ ...config, auth: 'auto' });
  let info;
  try {
    // An authenticated request: a wrong password surfaces here as the
    // transport's UNAUTHORIZED (401 after the Digest retry).
    const type = deviceTypeOf(await magicBox(client, 'getDeviceType'));
    if (!type) throw new AppError('DEVICE_ERROR', `${host} did not answer the Dahua device-type request.`);
    // Identity extras are best effort: a missing one must not block the session.
    const optional = async (action, key) => {
      try { return (await magicBox(client, action))?.get(key)?.trim() || null; } catch (err) {
        if (err instanceof AppError && err.code === 'UNAUTHORIZED') throw err;
        return null;
      }
    };
    const firmware = await optional('getSoftwareVersion', 'version');
    const serial = await optional('getSerialNo', 'sn');
    // OEM firmware (Lorex, Amcrest) names itself here; Dahua-branded firmware
    // says "Dahua" or does not implement it. assumed from vendor docs, not
    // hardware-verified.
    const vendor = await optional('getVendor', 'vendor');
    info = { vendor: vendor ?? 'Dahua', model: type, firmware, serial };
  } catch (err) {
    client.close();
    throw err;
  }

  let closed = false;
  let targets = null; // [{ public, ch, stream }]
  const presence = new Map(); // table name -> Set of native keys seen at describe time
  const descriptorCache = new Map();

  async function getTable(name) {
    const res = await client.request({ path: `${CONFIG}?action=getConfig&name=${name}` });
    if (res.status !== 200 || isErrorBody(res.text)) {
      throw new AppError('DEVICE_ERROR', `${host} refused to read ${name} (HTTP ${res.status}).`);
    }
    return parseTable(res.text);
  }

  /** A table the device does not implement is empty, not an error, for discovery. */
  async function tableKeys(name) {
    if (presence.has(name)) return presence.get(name);
    let keys;
    try {
      keys = new Set((await getTable(name)).keys());
    } catch (err) {
      if (err instanceof AppError && err.code === 'DEVICE_ERROR') keys = new Set();
      else throw err;
    }
    presence.set(name, keys);
    return keys;
  }

  /**
   * Channel count. Cameras report their sensors in VideoInputChannels;
   * recorders report IP-camera slots in MaxRemoteInputChannels, and hybrid
   * XVRs report both (analog inputs first, IP channels numbered after them),
   * so the count is their sum. When the product definition is missing, the
   * ChannelTitle table's indexes are the device's own channel list.
   * assumed from vendor docs, not hardware-verified.
   */
  async function channelCount(titleKeys) {
    let def = null;
    try {
      const res = await client.request({ path: `${MAGIC_BOX}?action=getProductDefinition` });
      if (res.status === 200 && !isErrorBody(res.text)) def = parseTable(res.text);
    } catch (err) {
      if (err instanceof AppError && err.code === 'UNAUTHORIZED') throw err;
    }
    const local = toInt(def?.get('VideoInputChannels')) ?? 0;
    const remote = toInt(def?.get('MaxRemoteInputChannels')) ?? 0;
    if (local + remote > 0) return Math.min(local + remote, MAX_CHANNELS);
    const indexes = new Set();
    for (const key of titleKeys) {
      const m = /^ChannelTitle\[(\d+)\]\./.exec(key);
      if (m) indexes.add(Number(m[1]));
    }
    return indexes.size > 0 ? Math.min(Math.max(...indexes) + 1, MAX_CHANNELS) : 1;
  }

  async function loadTargets() {
    if (targets) return targets;
    let titles = new Map();
    try { titles = await getTable('ChannelTitle'); } catch (err) {
      if (!(err instanceof AppError && err.code === 'DEVICE_ERROR')) throw err;
    }
    const count = await channelCount(titles.keys());
    const encodeKeys = await tableKeys('Encode');
    const out = [];
    for (let ch = 0; ch < count; ch += 1) {
      const n = ch + 1; // operator channel is 1-based; native index is 0-based
      const name = titles.get(`ChannelTitle[${ch}].Name`)?.trim();
      out.push({ public: { id: `channel:${n}`, scope: 'channel', label: name || `Channel ${n}`, channel: n }, ch, stream: null });
      for (const [stream, streamLabel] of [['main', 'Main stream'], ['sub', 'Sub stream']]) {
        // Only streams the device actually configures become targets.
        if (!encodeKeys.has(`${prefixFor('Encode', ch, stream)}Compression`)) continue;
        out.push({
          public: { id: `stream:${n}:${stream}`, scope: 'stream', label: streamLabel, channel: n, parent: `channel:${n}` },
          ch,
          stream,
        });
      }
    }
    targets = out;
    return out;
  }

  async function requireTarget(targetId) {
    const t = (await loadTargets()).find((x) => x.public.id === targetId);
    if (!t) throw new AppError('NOT_FOUND', `No target "${targetId}" on this device.`);
    return t;
  }

  const fieldsOf = (t) => (t.stream ? STREAM_FIELDS : CHANNEL_FIELDS);

  /** Descriptors are what the device showed us: a field whose native paths are absent is not described. */
  async function describe(t) {
    if (descriptorCache.has(t.public.id)) return descriptorCache.get(t.public.id);
    const out = [];
    for (const [key, field] of Object.entries(fieldsOf(t))) {
      const keys = await tableKeys(field.table);
      if (pathsOf(field, t.ch, t.stream).every((p) => keys.has(p))) out.push(toDescriptor(key, field, t.ch, t.stream));
    }
    descriptorCache.set(t.public.id, out);
    return out;
  }

  /** One getConfig per native table, however many keys of it are wanted. */
  async function readValues(t, keys) {
    const described = new Set((await describe(t)).map((d) => d.key));
    const fields = fieldsOf(t);
    const byTable = new Map();
    for (const key of keys) {
      if (!described.has(key)) continue;
      const table = fields[key].table;
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table).push(key);
    }
    const values = {};
    for (const [tableName, tableKeysWanted] of byTable) {
      const table = await getTable(tableName);
      for (const key of tableKeysWanted) {
        const value = decodeField(fields[key], table, t.ch, t.stream);
        if (value !== undefined) values[key] = value;
      }
    }
    return values;
  }

  async function write(targetId, patch) {
    const t = await requireTarget(targetId);
    const descriptors = await describe(t);
    // Throws BAD_REQUEST before anything reaches the wire.
    const used = validatePatch(patch, descriptors);
    if ('video.resolution' in patch && !RESOLUTION_RE.test(patch['video.resolution'])) {
      throw new AppError('BAD_REQUEST', '"video.resolution" must look like "1920x1080".');
    }
    const fields = fieldsOf(t);

    const groups = new Map();
    for (const key of Object.keys(patch)) {
      const resource = used[key].resource;
      if (!groups.has(resource)) groups.set(resource, []);
      groups.get(resource).push(key);
    }

    const result = { source: id, results: {}, values: {} };
    for (const [resource, keys] of groups) {
      // Lock, then governed requests inside it (§7) — never the reverse.
      const part = await withResourceLock(lockKey(host, port, resource), async () => {
        const table = fields[keys[0]].table;
        const current = await getTable(table);
        const before = Object.fromEntries(keys.map((k) => [k, decodeField(fields[k], current, t.ch, t.stream)]));
        // Only the requested fields go on the wire: setConfig is partial.
        const pairs = [];
        for (const key of keys) {
          const paths = pathsOf(fields[key], t.ch, t.stream);
          const raws = fields[key].encode(patch[key]);
          paths.forEach((p, i) => pairs.push([p, raws[i]]));
        }
        const res = await client.request({ path: `${CONFIG}?action=setConfig&${setConfigQuery(pairs)}` });
        // "Error" (or any non-2xx) refuses the whole request; Dahua does not
        // name the offending field, so every field of this group is rejected.
        const refused = res.status < 200 || res.status >= 300 || isErrorBody(res.text);
        const subPatch = Object.fromEntries(keys.map((k) => [k, patch[k]]));
        return verifyWrite({
          patch: subPatch,
          before,
          descriptors: used,
          rejected: refused ? keys : [],
          source: id,
          readBack: async () => {
            const fresh = await getTable(table);
            return Object.fromEntries(keys.map((k) => [k, decodeField(fields[k], fresh, t.ch, t.stream)]));
          },
        });
      });
      Object.assign(result.results, part.results);
      Object.assign(result.values, part.values);
    }
    return result;
  }

  return {
    id,
    label,
    info,
    async listTargets() {
      return (await loadTargets()).map((x) => ({ ...x.public }));
    },
    async describeSettings(targetId) {
      return (await describe(await requireTarget(targetId))).map((d) => ({ ...d, ...(d.values ? { values: [...d.values] } : {}) }));
    },
    async read(targetId, keys) {
      const t = await requireTarget(targetId);
      const wanted = keys ?? (await describe(t)).map((d) => d.key);
      return { values: await readValues(t, wanted), source: id };
    },
    write,
    close() {
      if (closed) return;
      closed = true;
      client.close();
    },
  };
}
