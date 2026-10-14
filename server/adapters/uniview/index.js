// Verification: mock-verified (persona uniview-ipc)
/**
 * Uniview adapter for the LiteAPI (LAPI) V1.0 (ADAPTERS.md §5–§7).
 *
 * Uniview cameras and NVRs expose a JSON "LiteAPI" alongside ONVIF. NVR
 * channels are first-class LAPI objects, so a recorder surfaces here as one
 * channel target (imaging) plus one stream target per video encoder stream,
 * exactly like the native-API adapters for the other recorder vendors.
 *
 * Two LAPI quirks drive the shape of this file:
 * - Every response is an envelope: a request can fail with ResponseCode != 0
 *   on HTTP 200. The write path reads the envelope, not just the status.
 * - The video encoder resource is the WHOLE array of stream objects: a PUT
 *   must send every stream back with only the requested stream's requested
 *   fields changed, or the device treats it as a partial object and refuses.
 */
import { AppError } from '../../errors.js';
import { createHttpClient } from '../../transport/http.js';
import { withResourceLock, lockKey } from '../../transport/lock.js';
import { validatePatch, verifyWrite } from '../../settings/contract.js';

export const id = 'uniview';
export const label = 'Uniview LAPI';
export const priority = 40;
export const defaultPorts = [80];

// Every LAPI path this adapter speaks, in one place. Uniview documents LAPI
// per series and firmware varies, so each is marked where it is assumed.
const LAPI = Object.freeze({
  deviceInfo: '/LAPI/V1.0/System/DeviceInfo',              // assumed from vendor docs, not hardware-verified
  channels: '/LAPI/V1.0/Channels',                         // assumed from vendor docs, not hardware-verified
  imageBasic: (ch) => `/LAPI/V1.0/Channels/${ch}/Image/Basic`,     // assumed from vendor docs, not hardware-verified
  imageDayNight: (ch) => `/LAPI/V1.0/Channels/${ch}/Image/DayNight`, // assumed from vendor docs, not hardware-verified
  videoEncoder: (ch) => `/LAPI/V1.0/Channels/${ch}/Media/VideoEncoder`, // assumed from vendor docs, not hardware-verified
});

// Canonical key -> LAPI Image/Basic field. Uniview documents these as fixed
// 0..100 integers (assumed from vendor docs, not hardware-verified); they are
// NOT rescaled, per ADAPTERS.md §3.
const BASIC_FIELDS = Object.freeze({
  'image.brightness': 'Brightness',
  'image.contrast': 'Contrast',
  'image.saturation': 'Saturation',
  'image.sharpness': 'Sharpness',
});
const BASIC_RANGE = Object.freeze({ min: 0, max: 100, step: 1 });

// Canonical <-> native value maps. LAPI spells day/night and the codec names
// exactly the canonical way; only the bitrate mode differs in case.
const DAY_NIGHT_VALUES = Object.freeze(['auto', 'day', 'night']);
const BITRATE_MODE_TO_CANONICAL = Object.freeze({ CBR: 'cbr', VBR: 'vbr' });
const BITRATE_MODE_TO_NATIVE = Object.freeze({ cbr: 'CBR', vbr: 'VBR' });

/** Pull the Data payload out of an LAPI envelope, or throw an honest error. */
function lapiData(res, host, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new AppError('DEVICE_ERROR', `${host} rejected ${what} (HTTP ${res.status}).`);
  }
  let body;
  try { body = res.json(); } catch {
    throw new AppError('DEVICE_ERROR', `${host} returned a malformed LAPI response while ${what}.`);
  }
  const inner = body?.Response;
  if (!inner || typeof inner !== 'object') {
    throw new AppError('DEVICE_ERROR', `${host} returned a malformed LAPI response while ${what}.`);
  }
  if (inner.ResponseCode !== 0) {
    throw new AppError('DEVICE_ERROR', `${host} refused ${what}: ${inner.StatusString ?? `ResponseCode ${inner.ResponseCode}`}.`);
  }
  return inner.Data;
}

/** True when a PUT was refused — by status or by a non-zero ResponseCode. */
function lapiRefused(res) {
  if (res.status < 200 || res.status >= 300) return true;
  try {
    return res.json()?.Response?.ResponseCode !== 0;
  } catch {
    return true; // a success we cannot parse is not a success
  }
}

export async function probe(config) {
  const client = createHttpClient({ ...config, auth: 'auto', timeoutMs: config.timeoutMs ?? 3000 });
  try {
    const res = await client.request({ path: LAPI.deviceInfo });
    if (res.status !== 200) return { match: false, confidence: 0 };
    // Match on CONTENT, not the 200: a plain web server 404s this path, and
    // any JSON-speaking box must still carry the Uniview envelope shape.
    let body;
    try { body = res.json(); } catch { return { match: false, confidence: 0 }; }
    const data = body?.Response?.ResponseCode === 0 ? body.Response.Data : null;
    if (!data || typeof data !== 'object') return { match: false, confidence: 0 };
    if (!/uniview|^unv$/i.test(String(data.Manufacturer ?? ''))) return { match: false, confidence: 0 };
    return {
      match: true,
      confidence: 0.95,
      model: typeof data.DeviceModel === 'string' ? data.DeviceModel : undefined,
      firmware: typeof data.FirmwareVersion === 'string' ? data.FirmwareVersion : undefined,
    };
  } catch {
    // Auth failure, unreachable host, garbage body — none of it proves a vendor.
    return { match: false, confidence: 0 };
  } finally {
    client.close();
  }
}

export async function connect(config) {
  const client = createHttpClient({ ...config, auth: 'auto' });
  const { host, port } = config;

  async function getJson(path, what) {
    return lapiData(await client.request({ path }), host, what);
  }

  const info = await getJson(LAPI.deviceInfo, 'reading device info');
  const channels = await getJson(LAPI.channels, 'reading channels');
  if (!Array.isArray(channels) || channels.length === 0) {
    client.close();
    throw new AppError('DEVICE_ERROR', `${host} returned no LAPI channels.`);
  }

  // Discover the encoder streams per channel now, so listTargets can offer
  // one stream target per native stream and describeSettings can declare the
  // codec/bitrate-mode enums the device actually reports.
  const channelsById = new Map();
  for (const ch of channels) {
    const channelId = Number(ch?.ChannelID);
    if (!Number.isInteger(channelId)) continue;
    const encoder = await getJson(LAPI.videoEncoder(channelId), `reading the encoder of channel ${channelId}`);
    if (!Array.isArray(encoder)) {
      client.close();
      throw new AppError('DEVICE_ERROR', `${host} returned a malformed encoder list for channel ${channelId}.`);
    }
    channelsById.set(channelId, encoder);
  }
  if (channelsById.size === 0) {
    client.close();
    throw new AppError('DEVICE_ERROR', `${host} returned no usable LAPI channels.`);
  }

  // Targets and descriptors are cached for the connection's life (ADAPTERS.md
  // §5): reads always hit the wire fresh, but we never re-probe per read.
  const targets = [];
  const descriptorsByTarget = new Map();
  for (const [channelId, encoder] of channelsById) {
    const channelTarget = { id: `channel:${channelId}`, scope: 'channel', label: `Channel ${channelId}`, channel: channelId };
    const basicResource = `image/basic:${channelId}`;
    const dayNightResource = `image/daynight:${channelId}`;
    const encoderResource = `media/videoencoder:${channelId}`;
    targets.push(channelTarget);
    descriptorsByTarget.set(channelTarget.id, [
      ...Object.entries(BASIC_FIELDS).map(([key, native]) => ({
        key,
        label: native,
        group: 'imaging',
        type: 'int',
        unit: null,
        ...BASIC_RANGE,
        writable: true,
        resource: basicResource,
      })),
      {
        key: 'image.dayNight',
        label: 'Day/Night',
        group: 'imaging',
        type: 'enum',
        unit: null,
        values: [...DAY_NIGHT_VALUES],
        writable: true,
        resource: dayNightResource,
      },
    ]);

    for (const stream of encoder) {
      const streamType = String(stream?.VideoStreamType ?? '');
      if (!streamType) continue;
      const streamTarget = {
        id: `stream:${channelId}.${streamType}`,
        scope: 'stream',
        label: `${streamType === 'major' ? 'Main' : streamType === 'minor' ? 'Sub' : streamType} stream`,
        channel: channelId,
        parent: channelTarget.id,
      };
      targets.push(streamTarget);
      descriptorsByTarget.set(streamTarget.id, buildStreamDescriptors(encoder, encoderResource));
    }
  }

  const targetById = new Map(targets.map((t) => [t.id, t]));
  const requireTarget = (targetId) => {
    const target = targetById.get(targetId);
    if (!target) throw new AppError('NOT_FOUND', `No target "${targetId}" on this device.`);
    return target;
  };

  /** GET one native resource object (the encoder resource is an array). */
  async function fetchResource(resource) {
    const [kind, id] = resource.split(':');
    const ch = Number(id);
    if (kind === 'image/basic') return getJson(LAPI.imageBasic(ch), 'reading imaging');
    if (kind === 'image/daynight') return getJson(LAPI.imageDayNight(ch), 'reading day/night mode');
    if (kind === 'media/videoencoder') return getJson(LAPI.videoEncoder(ch), 'reading the encoder');
    throw new AppError('INTERNAL', `Unknown resource "${resource}".`);
  }

  /** Extract one canonical key from its freshly-read native resource. */
  function extract(key, native, target) {
    if (BASIC_FIELDS[key]) return native?.[BASIC_FIELDS[key]];
    if (key === 'image.dayNight') return native?.DayNightMode;
    const streamType = String(target.id.split(':')[1].split('.')[1]);
    const stream = (Array.isArray(native) ? native : []).find((s) => s.VideoStreamType === streamType) ?? {};
    switch (key) {
      case 'video.codec': return stream.EncodeFormat;
      case 'video.resolution': return typeof stream.Resolution === 'string' ? stream.Resolution.replace('*', 'x') : undefined;
      case 'video.fps': return stream.FrameRate;
      case 'video.bitrate': return stream.BitRate;
      case 'video.bitrateMode': return BITRATE_MODE_TO_CANONICAL[stream.BitRateType];
      case 'video.gop': return stream.GOP;
      default: return undefined;
    }
  }

  async function readValues(targetId, keys) {
    const target = requireTarget(targetId);
    const descriptors = descriptorsByTarget.get(targetId);
    const wanted = keys ?? descriptors.map((d) => d.key);
    // Group by resource so one read is one GET, whatever keys were asked for.
    const byResource = new Map();
    for (const key of wanted) {
      const d = descriptors.find((x) => x.key === key);
      if (!d) throw new AppError('BAD_REQUEST', `This target has no setting "${key}".`);
      if (!byResource.has(d.resource)) byResource.set(d.resource, []);
      byResource.get(d.resource).push(key);
    }
    const values = {};
    for (const [resource, resourceKeys] of byResource) {
      const native = await fetchResource(resource);
      for (const key of resourceKeys) values[key] = extract(key, native, target);
    }
    return values;
  }

  async function write(targetId, patch) {
    const target = requireTarget(targetId);
    const descriptors = descriptorsByTarget.get(targetId);
    // Invalid input never reaches the wire (ADAPTERS.md §6).
    const used = validatePatch(patch, descriptors);

    // Group by resource; each group is one read-modify-write under its lock.
    const byResource = new Map();
    for (const key of Object.keys(patch)) {
      const resource = used[key].resource;
      if (!byResource.has(resource)) byResource.set(resource, []);
      byResource.get(resource).push(key);
    }

    const before = {};
    const rejected = [];
    for (const [resource, keys] of byResource) {
      await withResourceLock(lockKey(host, port, resource), async () => {
        const current = await fetchResource(resource);
        for (const key of keys) before[key] = extract(key, current, target);

        let body;
        if (resource.startsWith('image/basic:')) {
          body = { ...current };
          for (const key of keys) body[BASIC_FIELDS[key]] = patch[key];
        } else if (resource.startsWith('image/daynight:')) {
          body = { ...current };
          for (const key of keys) body.DayNightMode = patch[key];
        } else {
          // The device requires the whole stream array; send it whole with
          // only the requested stream's requested fields changed.
          const streamType = String(target.id.split(':')[1].split('.')[1]);
          body = (Array.isArray(current) ? current : []).map((s) => {
            if (s.VideoStreamType !== streamType) return s;
            const next = { ...s };
            for (const key of keys) {
              if (key === 'video.resolution') next.Resolution = patch[key].replace('x', '*');
              else if (key === 'video.bitrateMode') next.BitRateType = BITRATE_MODE_TO_NATIVE[patch[key]];
              else next[{ 'video.codec': 'EncodeFormat', 'video.fps': 'FrameRate', 'video.bitrate': 'BitRate', 'video.gop': 'GOP' }[key]] = patch[key];
            }
            return next;
          });
        }

        const res = await client.request({ method: 'PUT', path: pathFor(resource), body });
        // A refused field is reported, not thrown (ADAPTERS.md §6); only a
        // whole-request transport failure throws, and that comes from the client.
        if (lapiRefused(res)) rejected.push(...keys);
      });
    }

    return verifyWrite({
      patch,
      before,
      descriptors: used,
      rejected,
      source: 'uniview',
      readBack: async () => readValues(targetId, Object.keys(patch).filter((k) => !rejected.includes(k))),
    });
  }

  function pathFor(resource) {
    const [kind, id] = resource.split(':');
    const ch = Number(id);
    if (kind === 'image/basic') return LAPI.imageBasic(ch);
    if (kind === 'image/daynight') return LAPI.imageDayNight(ch);
    if (kind === 'media/videoencoder') return LAPI.videoEncoder(ch);
    throw new AppError('INTERNAL', `Unknown resource "${resource}".`);
  }

  return {
    id: 'uniview',
    label,
    info: {
      vendor: 'Uniview',
      model: typeof info.DeviceModel === 'string' ? info.DeviceModel : null,
      firmware: typeof info.FirmwareVersion === 'string' ? info.FirmwareVersion : null,
      serial: null,
    },
    listTargets: async () => targets.map((t) => ({ ...t })),
    describeSettings: async (targetId) => {
      requireTarget(targetId);
      return descriptorsByTarget.get(targetId).map((d) => ({ ...d, values: d.values ? [...d.values] : undefined }));
    },
    read: async (targetId, keys) => ({ values: await readValues(targetId, keys), source: 'uniview' }),
    write,
    close() { try { client.close(); } catch { /* idempotent, never throws */ } },
  };
}

/**
 * Encoder descriptors for one stream. Enum values are only what the device
 * reported across the channel's streams (ADAPTERS.md §3); LAPI's GET returns
 * the current value per stream, not the candidate lists, so resolution is
 * declared as a plain string rather than a guessed enum.
 */
function buildStreamDescriptors(encoder, resource) {
  const seen = (pick) => [...new Set(encoder.map(pick).filter((v) => v !== undefined && v !== null))];
  return [
    {
      key: 'video.codec',
      label: 'Codec',
      group: 'encoder',
      type: 'enum',
      unit: null,
      values: seen((s) => s.EncodeFormat),
      writable: true,
      resource,
    },
    {
      key: 'video.resolution',
      label: 'Resolution',
      group: 'encoder',
      type: 'string',
      unit: null,
      writable: true,
      resource,
    },
    {
      key: 'video.fps',
      label: 'Frame rate',
      group: 'encoder',
      type: 'number',
      unit: 'fps',
      writable: true,
      resource,
    },
    {
      key: 'video.bitrate',
      label: 'Bitrate',
      group: 'encoder',
      type: 'int',
      unit: 'kbps',
      writable: true,
      resource,
    },
    {
      key: 'video.bitrateMode',
      label: 'Bitrate mode',
      group: 'encoder',
      type: 'enum',
      unit: null,
      values: seen((s) => BITRATE_MODE_TO_CANONICAL[s.BitRateType]),
      writable: true,
      resource,
    },
    {
      key: 'video.gop',
      label: 'GOP',
      group: 'encoder',
      type: 'int',
      unit: null,
      writable: true,
      resource,
    },
  ];
}
