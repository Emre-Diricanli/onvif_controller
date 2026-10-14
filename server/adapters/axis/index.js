// Verification: mock-verified (persona axis-p3245)
/**
 * Axis VAPIX adapter (ADAPTERS.md).
 *
 * Axis firmware speaks two HTTP API generations: the text-based param.cgi
 * (one `<fullpath>=<value>` per line, `action=list` / `action=update`) and
 * the VAPIX 3 JSON CGIs such as basicdeviceinfo.cgi. This adapter uses the
 * JSON CGI only to identify the device (probe/connect) and does all settings
 * work through param.cgi: that is where imaging and encoder settings live,
 * and its per-line "OK" / "# Error:" update replies map directly onto the
 * per-field write outcomes the contract asks for (§6).
 *
 * Every exchange goes through server/transport/http.js (auth 'auto' answers
 * the RFC 2617 Digest challenge Axis firmware sends) and every write is a
 * param-group read-modify-write under a per-resource lock, confirmed by
 * read-back — a device's bare "OK" proves nothing (VENDOR.md).
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, verifyWrite } from '../../settings/contract.js';

export const id = 'axis';
export const label = 'Axis VAPIX';
export const priority = 25;
export const defaultPorts = [80];

const BASIC_DEVICE_INFO_PATH = '/axis-cgi/basicdeviceinfo.cgi';
const PARAM_CGI_PATH = '/axis-cgi/param.cgi';
const PROPS_BODY = { apiVersion: '1.0', method: 'getAllProperties' };

// The P3245 persona is a single-sensor camera: one sensor, I0. Axis names the
// image param groups after the sensor, so a multi-channel encoder would
// surface sensors I0..I(n-1); the target ids below are built from this list
// rather than hard-coded, so extending it is the only change needed.
const SENSORS = ['I0'];

const toInt = (raw) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
};

// Native <-> canonical value maps. The 0..100 range on the sensor controls is
// the fixed range Axis documents for these parameters, so it is declared even
// though the persona does not report it.
const SENSOR_INT = { min: 0, max: 100, step: 1 };
const WDR = { toNative: (v) => (v ? 'on' : 'off'), fromNative: (r) => r === 'on' };
const MIRROR = { toNative: (v) => (v ? 'yes' : 'no'), fromNative: (r) => r === 'yes' };
const DAY_NIGHT = {
  toNative: (v) => ({ auto: 'auto', day: 'color', night: 'bw' })[v],
  fromNative: (r) => ({ auto: 'auto', color: 'day', bw: 'night' })[r],
};
// IrCutFilter 'auto'|'yes'|'no' mapped onto image.irLight auto|on|off.
// assumed from vendor docs, not hardware-verified.
const IR_CUT = {
  toNative: (v) => ({ auto: 'auto', on: 'yes', off: 'no' })[v],
  fromNative: (r) => ({ auto: 'auto', yes: 'on', no: 'off' })[r],
};
// Codec short names as param.cgi reports them. assumed from vendor docs,
// not hardware-verified.
const CODEC = {
  toNative: (v) => ({ 'H.264': 'h264', 'H.265': 'h265', MJPEG: 'mjpeg' })[v],
  fromNative: (r) => ({ h264: 'H.264', h265: 'H.265', mjpeg: 'MJPEG' })[r],
};

/**
 * The setting fields of one sensor, split by the target they belong to.
 * `groupName` is the param.cgi group (the native object a read-modify-write
 * touches, hence the lock resource); `param` is the leaf name in that group.
 */
function buildFields(sensor) {
  const sensorG = `root.ImageSource.${sensor}.Sensor`;
  const dayNightG = `root.ImageSource.${sensor}.DayNight`;
  const irCutG = `root.ImageSource.${sensor}.IrCutFilter`;
  const appearanceG = `root.Image.${sensor}.Appearance`;
  const streamG = `root.Image.${sensor}.Stream`;
  const rateControlG = `root.Image.${sensor}.RateControl`;
  const res = (groupName) => `param:${groupName}`;
  return {
    channel: [
      { key: 'image.brightness', label: 'Brightness', group: 'imaging', type: 'int', unit: null, ...SENSOR_INT, writable: true, resource: res(sensorG), groupName: sensorG, param: 'Brightness', toNative: String, fromNative: toInt },
      { key: 'image.contrast', label: 'Contrast', group: 'imaging', type: 'int', unit: null, ...SENSOR_INT, writable: true, resource: res(sensorG), groupName: sensorG, param: 'Contrast', toNative: String, fromNative: toInt },
      { key: 'image.saturation', label: 'Color level', group: 'imaging', type: 'int', unit: null, ...SENSOR_INT, writable: true, resource: res(sensorG), groupName: sensorG, param: 'ColorLevel', toNative: String, fromNative: toInt },
      { key: 'image.sharpness', label: 'Sharpness', group: 'imaging', type: 'int', unit: null, ...SENSOR_INT, writable: true, resource: res(sensorG), groupName: sensorG, param: 'Sharpness', toNative: String, fromNative: toInt },
      { key: 'image.wdr', label: 'WDR', group: 'imaging', type: 'bool', unit: null, writable: true, resource: res(sensorG), groupName: sensorG, param: 'WDR', ...WDR },
      { key: 'image.dayNight', label: 'Day/Night', group: 'imaging', type: 'enum', unit: null, values: ['auto', 'day', 'night'], writable: true, resource: res(dayNightG), groupName: dayNightG, param: 'DayNightColor', ...DAY_NIGHT },
      { key: 'image.irLight', label: 'IR cut filter', group: 'imaging', type: 'enum', unit: null, values: ['auto', 'on', 'off'], writable: true, resource: res(irCutG), groupName: irCutG, param: 'IrCutFilter', ...IR_CUT },
      { key: 'image.mirror', label: 'Mirror', group: 'imaging', type: 'bool', unit: null, writable: true, resource: res(appearanceG), groupName: appearanceG, param: 'Mirror', ...MIRROR },
      // Rotation stays vendor-namespaced: the native 0/90/180/270 does not
      // map exactly onto image.flip, so we do not claim the canonical key.
      { key: 'vendor.axis.rotation', label: 'Rotation', group: 'imaging', type: 'enum', unit: null, values: ['0', '90', '180', '270'], writable: true, resource: res(appearanceG), groupName: appearanceG, param: 'Rotation', toNative: (v) => v, fromNative: (r) => r },
    ],
    stream: [
      // The device reports only the current resolution, not the allowed list,
      // so this is a string, not an enum — a guessed list is worse than none.
      { key: 'video.resolution', label: 'Resolution', group: 'encoder', type: 'string', unit: null, writable: true, resource: res(appearanceG), groupName: appearanceG, param: 'Resolution', toNative: (v) => v, fromNative: (r) => r },
      { key: 'video.fps', label: 'Frame rate', group: 'encoder', type: 'int', unit: 'fps', writable: true, resource: res(streamG), groupName: streamG, param: 'FPS', toNative: String, fromNative: toInt },
      { key: 'video.codec', label: 'Codec', group: 'encoder', type: 'enum', unit: null, values: ['H.264', 'H.265', 'MJPEG'], writable: true, resource: res(streamG), groupName: streamG, param: 'Codec', ...CODEC },
      { key: 'video.bitrateMode', label: 'Rate control', group: 'encoder', type: 'enum', unit: null, values: ['cbr', 'vbr'], writable: true, resource: res(rateControlG), groupName: rateControlG, param: 'Mode', toNative: (v) => v, fromNative: (r) => r },
      { key: 'video.bitrate', label: 'Target bitrate', group: 'encoder', type: 'int', unit: 'kbps', writable: true, resource: res(rateControlG), groupName: rateControlG, param: 'TargetBitrate', toNative: String, fromNative: toInt },
    ],
  };
}

/** Strip the internal field-mapping keys before a descriptor leaves the adapter. */
function publicDescriptor(field) {
  const { groupName, param, toNative, fromNative, ...descriptor } = field;
  return descriptor;
}

/** Parse a param.cgi action=list body into { fullpath: value }. */
function parseParamList(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

/**
 * Cheap, read-only, never throws (ADAPTERS.md §5). The device is recognized
 * by response CONTENT, not by a 200: a plain 404 server must not match. The
 * primary probe is the VAPIX 3 basicdeviceinfo JSON CGI; the fallback is the
 * legacy param.cgi brand group. Two endpoints, at most 3 requests.
 */
export async function probe(config) {
  const client = createHttpClient({ ...config, auth: 'auto', timeoutMs: config.timeoutMs ?? 3000 });
  try {
    const res = await client.request({ method: 'POST', path: BASIC_DEVICE_INFO_PATH, body: PROPS_BODY });
    if (res.status === 200) {
      let body = null;
      try { body = res.json(); } catch { body = null; }
      const list = body?.data?.propertyList;
      if (list?.Brand === 'AXIS') {
        return {
          match: true,
          confidence: 0.95,
          model: list.ProdNbr ?? list.ProdFullName ?? undefined,
          firmware: list.Version ?? undefined,
        };
      }
    }
    const fallback = await client.request({ path: `${PARAM_CGI_PATH}?action=list&group=root.Brand` });
    if (fallback.status === 200 && fallback.text.includes('root.Brand.Brand=AXIS')) {
      return { match: true, confidence: 0.7 };
    }
    return { match: false, confidence: 0 };
  } catch {
    // Wrong credentials, unreachable host, timeout — all collapse to no-match.
    return { match: false, confidence: 0 };
  } finally {
    client.close();
  }
}

export async function connect(config) {
  const client = createHttpClient({ ...config, auth: 'auto' });
  let info;
  try {
    const res = await client.request({ method: 'POST', path: BASIC_DEVICE_INFO_PATH, body: PROPS_BODY });
    if (res.status !== 200) {
      throw new AppError('DEVICE_ERROR', `${config.host} did not answer the VAPIX device-info request (HTTP ${res.status}).`);
    }
    let body;
    try { body = res.json(); } catch {
      throw new AppError('DEVICE_ERROR', `${config.host} returned a malformed VAPIX device-info response.`);
    }
    const list = body?.data?.propertyList;
    if (list?.Brand !== 'AXIS') {
      throw new AppError('DEVICE_ERROR', `${config.host} did not identify itself as an Axis device.`);
    }
    info = {
      vendor: 'Axis',
      model: list.ProdNbr ?? list.ProdFullName ?? null,
      firmware: list.Version ?? null,
      serial: list.SerialNumber ?? null,
    };
  } catch (err) {
    client.close();
    throw err;
  }

  // Targets and descriptors are derived from the sensor list once and cached
  // for the connection's life — reads never re-probe (ADAPTERS.md §5).
  const targets = SENSORS.flatMap((sensor, index) => {
    const channel = index + 1;
    return [
      { id: `channel:${channel}`, scope: 'channel', label: SENSORS.length > 1 ? `Camera ${channel}` : 'Camera', channel },
      { id: `stream:${sensor}`, scope: 'stream', label: SENSORS.length > 1 ? `Stream ${channel}` : 'Stream 1', channel, parent: `channel:${channel}` },
    ];
  });
  const fieldsByTarget = new Map();
  const descriptorsByTarget = new Map();
  for (const [index, sensor] of SENSORS.entries()) {
    const fields = buildFields(sensor);
    fieldsByTarget.set(`channel:${index + 1}`, fields.channel);
    descriptorsByTarget.set(`channel:${index + 1}`, fields.channel.map(publicDescriptor));
    fieldsByTarget.set(`stream:${sensor}`, fields.stream);
    descriptorsByTarget.set(`stream:${sensor}`, fields.stream.map(publicDescriptor));
  }
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const requireTarget = (targetId) => {
    const target = targetById.get(targetId);
    if (!target) throw new AppError('NOT_FOUND', `No target "${targetId}" on this device.`);
    return target;
  };

  // One GET per group, even when several settings of that group are wanted:
  // param.cgi has no per-parameter read, and the governor prices every byte.
  const listGroup = async (groupName) => {
    const res = await client.request({ path: `${PARAM_CGI_PATH}?action=list&group=${encodeURIComponent(groupName)}` });
    if (res.status !== 200) {
      throw new AppError('DEVICE_ERROR', `${config.host} refused the param.cgi read for ${groupName} (HTTP ${res.status}).`);
    }
    return parseParamList(res.text);
  };

  const readFields = async (targetId, fields, keys) => {
    const wanted = new Set(keys ?? fields.map((f) => f.key));
    const groups = new Map();
    for (const f of fields) {
      if (!wanted.has(f.key)) continue;
      if (!groups.has(f.groupName)) groups.set(f.groupName, []);
      groups.get(f.groupName).push(f);
    }
    const values = {};
    for (const [groupName, groupFields] of groups) {
      const native = await listGroup(groupName);
      for (const f of groupFields) {
        const raw = native[`${groupName}.${f.param}`];
        if (raw === undefined) continue;
        const value = f.fromNative(raw);
        if (value !== undefined) values[f.key] = value;
      }
    }
    return values;
  };

  return {
    id,
    label,
    info,
    async listTargets() { return targets; },
    async describeSettings(targetId) {
      requireTarget(targetId);
      return descriptorsByTarget.get(targetId);
    },
    async read(targetId, keys) {
      requireTarget(targetId);
      return { values: await readFields(targetId, fieldsByTarget.get(targetId), keys), source: id };
    },
    async write(targetId, patch) {
      requireTarget(targetId);
      const fields = fieldsByTarget.get(targetId);
      const descriptors = descriptorsByTarget.get(targetId);
      // validatePatch throws BAD_REQUEST before anything reaches the wire.
      const used = validatePatch(patch, descriptors);

      // Group the accepted keys by their native resource so each group is
      // read-modified-written once, under its own lock (ADAPTERS.md §6/§7).
      const byResource = new Map();
      for (const [key, d] of Object.entries(used)) {
        const field = fields.find((f) => f.key === key);
        if (!byResource.has(d.resource)) byResource.set(d.resource, []);
        byResource.get(d.resource).push({ key, field });
      }

      const result = { source: id, results: {}, values: {} };
      for (const [resource, items] of byResource) {
        const part = await withResourceLock(lockKey(config.host, config.port, resource), async () => {
          const groupName = items[0].field.groupName;
          const beforeNative = await listGroup(groupName);
          const before = {};
          for (const { key, field } of items) {
            before[key] = field.fromNative(beforeNative[`${groupName}.${field.param}`]);
          }
          // Change ONLY the requested params: the update query carries no
          // value the operator did not ask for.
          const pairs = items.map(({ key, field }) => [`${groupName}.${field.param}`, field.toNative(patch[key])]);
          const query = pairs.map(([p, v]) => `${encodeURIComponent(p)}=${encodeURIComponent(v)}`).join('&');
          const res = await client.request({ path: `${PARAM_CGI_PATH}?action=update&${query}` });
          // VAPIX answers 200 with one line per param: "OK", or "# Error:"
          // when the device refused that param. A non-200 is a whole-request
          // failure (§6: per-field refusals never throw; transport failures do).
          if (res.status !== 200) {
            throw new AppError('DEVICE_ERROR', `${config.host} refused the param.cgi update for ${groupName} (HTTP ${res.status}).`);
          }
          const lines = res.text.split('\n').map((l) => l.trim());
          const rejected = items
            .filter((_, i) => (lines[i] ?? '').startsWith('#'))
            .map(({ key }) => key);
          return verifyWrite({
            patch: Object.fromEntries(items.map(({ key }) => [key, patch[key]])),
            before,
            descriptors: used,
            rejected,
            source: id,
            readBack: async () => readFields(targetId, fields, items.map(({ key }) => key)),
          });
        });
        Object.assign(result.results, part.results);
        Object.assign(result.values, part.values);
      }
      return result;
    },
    close() { client.close(); },
  };
}
