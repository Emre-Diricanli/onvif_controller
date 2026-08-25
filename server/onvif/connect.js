import onvif from 'onvif';
import net from 'node:net';
import dns from 'node:dns/promises';
import { AppError, mapOnvifError } from '../errors.js';
import { config } from '../config.js';
import { callCam, tryCam, asArray, num, authorizeUri } from './util.js';
import { describeProfiles, describeSources } from './media.js';
import { readPtzCapabilities } from './ptz.js';
import { readRelayOutputs } from './device.js';

const { Cam } = onvif;

/**
 * Cloud instance metadata addresses. This app is operated from hosts inside AWS,
 * so an operator-supplied "camera host" is a live SSRF vector.
 *
 * Note what is deliberately NOT blocked: private RFC1918 ranges. Reaching
 * cameras on the LAN is the entire purpose of this tool, so blocking 192.168/16
 * or 10/8 would break it. Link-local (169.254/16) is blocked because it is APIPA
 * plus the metadata service — never a working camera address.
 */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',   // AWS / Azure / GCP / OpenStack IMDS
  '100.100.100.200',   // Alibaba Cloud
  'fd00:ec2::254',     // AWS IMDS over IPv6
]);

const METADATA_HOSTNAMES = [
  /^metadata\.google\.internal$/i,
  /^metadata\.goog$/i,
  /^instance-data(\.[a-z0-9.-]+)?$/i,
];

function isBlockedAddress(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (METADATA_ADDRESSES.has(normalized)) return true;

  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    // 169.254.0.0/16 — APIPA and every cloud metadata service that rides on it.
    if (octets[0] === 169 && octets[1] === 254) return true;
  }
  if (version === 6) {
    // fe80::/10 link-local, and the fd00:ec2::/32 IMDS prefix.
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
    if (normalized.startsWith('fd00:ec2:')) return true;
  }
  return false;
}

export function assertSafeHost(host) {
  if (typeof host !== 'string' || !host.trim()) {
    throw new AppError('BAD_REQUEST', 'A camera host or IP address is required.');
  }
  const trimmed = host.trim().replace(/^\[|\]$/g, '');
  if (/[\s/\\?#]/.test(trimmed)) {
    throw new AppError('BAD_REQUEST', 'Enter just the host or IP address, without a URL path.');
  }
  if (METADATA_HOSTNAMES.some((re) => re.test(trimmed)) || isBlockedAddress(trimmed)) {
    throw new AppError('BAD_REQUEST', 'That address is not a camera.',
      'Cloud metadata and link-local addresses are blocked because this app makes requests on your behalf.');
  }
  return trimmed;
}

/**
 * Resolve the host once, reject every address it maps to that is blocked, and
 * return the pinned IP. Connecting to the resolved address rather than the name
 * closes the DNS-rebinding window between the check and the connect.
 */
async function resolveSafeHost(host) {
  const trimmed = assertSafeHost(host);
  if (net.isIP(trimmed)) return trimmed;

  let records;
  try {
    records = await dns.lookup(trimmed, { all: true });
  } catch {
    throw new AppError('DEVICE_UNREACHABLE', `The hostname "${trimmed}" could not be resolved.`,
      'Use the camera IP address instead of a hostname, or fix DNS on this machine.');
  }
  if (!records.length) {
    throw new AppError('DEVICE_UNREACHABLE', `The hostname "${trimmed}" did not resolve to any address.`);
  }
  // Reject if ANY resolved address is blocked — a name that returns both a safe
  // and a blocked address is exactly the rebinding case we care about.
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new AppError('BAD_REQUEST', `"${trimmed}" resolves to a blocked address.`,
        'Cloud metadata and link-local addresses are blocked because this app makes requests on your behalf.');
    }
  }
  return records[0].address;
}

function connectCam({ host, port, username, password }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', `${host} did not answer in ${config.onvifTimeoutMs / 1000}s.`,
        'Check the subnet or VLAN route, and confirm the ONVIF port is not filtered by a firewall.'));
    }, config.onvifTimeoutMs);

    let cam;
    try {
      cam = new Cam(
        {
          hostname: host,
          username,
          password,
          port,
          timeout: config.onvifTimeoutMs,
          // Cameras behind NAT advertise their own LAN address in service
          // XAddrs. Without this every follow-up call goes to an unreachable IP.
          preserveAddress: true,
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(mapOnvifError(err, { host, port }));
          else resolve(cam);
        },
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(mapOnvifError(err, { host, port }));
    }
  });
}

/**
 * Build the capability matrix.
 *
 * Source of truth is GetServices (`cam.services`), not GetCapabilities: the
 * `onvif` library prefers GetServices on any device that supports it and then
 * never populates `cam.capabilities` at all, so reading only the latter reports
 * every service as absent. GetCapabilities is the fallback for older firmware.
 */
const SERVICE_NAMESPACES = {
  media: /ver10\/media\/wsdl/i,
  media2: /ver20\/media\/wsdl/i,
  ptz: /ver20\/ptz\/wsdl/i,
  imaging: /ver20\/imaging\/wsdl/i,
  events: /ver10\/events\/wsdl/i,
  analytics: /ver20\/analytics\/wsdl/i,
  recording: /ver10\/recording\/wsdl/i,
  deviceIO: /ver10\/deviceIO\/wsdl/i,
};

function readCapabilityMatrix(cam) {
  const services = asArray(cam.services);
  const has = (key) => services.some((s) => typeof s?.namespace === 'string' && SERVICE_NAMESPACES[key].test(s.namespace));

  const caps = cam.capabilities ?? {};
  const fallback = (key, ...paths) => {
    for (const path of paths) if (path) return true;
    return false;
  };

  return {
    media: has('media') || fallback('media', caps.media?.XAddr, caps.Media?.XAddr),
    media2: has('media2'),
    ptz: has('ptz') || fallback('ptz', caps.PTZ?.XAddr, caps.ptz?.XAddr),
    imaging: has('imaging') || fallback('imaging', caps.imaging?.XAddr, caps.Imaging?.XAddr),
    events: has('events') || fallback('events', caps.events?.XAddr, caps.Events?.XAddr),
    analytics: has('analytics') || fallback('analytics', caps.analytics?.XAddr, caps.Analytics?.XAddr),
    recording: has('recording'),
    deviceIO: has('deviceIO'),
    // Replaced with the real count once the relay outputs are actually read.
    relayOutputs: 0,
    audioBackchannel: Boolean(caps.media?.extension?.audioOutputs ?? false),
  };
}

/**
 * ONVIF digest auth signs a timestamp. More than ~5s of skew and every request
 * is rejected as "not authorized", which reads to the operator as a bad
 * password. Surface it explicitly instead.
 */
function readClock(systemDateAndTime) {
  const localTime = new Date();
  let deviceTime = null;

  // The library normalizes this differently depending on the device: usually a
  // bare Date, sometimes the raw UTCDateTime structure.
  if (systemDateAndTime instanceof Date) {
    deviceTime = systemDateAndTime;
  } else if (systemDateAndTime?.dateTime instanceof Date) {
    deviceTime = systemDateAndTime.dateTime;
  } else {
    const utc = systemDateAndTime?.UTCDateTime ?? systemDateAndTime?.utcDateTime;
    if (utc?.date && utc?.time) {
      deviceTime = new Date(Date.UTC(
        num(utc.date.year, 1970), num(utc.date.month, 1) - 1, num(utc.date.day, 1),
        num(utc.time.hour, 0), num(utc.time.minute, 0), num(utc.time.second, 0),
      ));
    }
  }

  if (!deviceTime || Number.isNaN(deviceTime.getTime())) {
    return { deviceTime: null, localTime: localTime.toISOString(), clockSkewSeconds: null };
  }
  return {
    deviceTime: deviceTime.toISOString(),
    localTime: localTime.toISOString(),
    clockSkewSeconds: Number(((localTime.getTime() - deviceTime.getTime()) / 1000).toFixed(1)),
  };
}

/**
 * Full connect + capability probe. Every optional probe is best-effort: a device
 * that supports only Profile S with no PTZ and no Imaging must still connect.
 */
export async function connectDevice({ host, port, username, password }) {
  const safeHost = await resolveSafeHost(host);
  const cam = await connectCam({ host: safeHost, port, username, password });
  const ctx = { host: safeHost, port };

  const [info, dateTime] = await Promise.all([
    callCam(cam, 'getDeviceInformation', undefined, { ctx }),
    tryCam(cam, 'getSystemDateAndTime', undefined, null, { ctx }),
  ]);

  const capabilities = readCapabilityMatrix(cam);
  const clock = readClock(dateTime);

  const { profiles, profileMap } = await describeProfiles(cam, {
    host: safeHost, port, username, password, ctx,
  });

  if (profiles.length === 0) {
    throw new AppError('DEVICE_ERROR', 'The device authenticated but reported no media profiles.',
      'On a Hikvision NVR, confirm at least one channel is online and that the ONVIF user has permission to view it.');
  }

  // Refresh explicitly because recorder firmware often does not populate the
  // library cache during Cam construction. Failure remains non-fatal: profiles
  // can still stream even when GetVideoSources is broken for an offline input.
  const videoSources = await tryCam(cam, 'getVideoSources', undefined, cam.videoSources ?? [], { ctx });
  const sources = describeSources(videoSources, profiles, profileMap, capabilities);
  const isMultiChannel = sources.length > 1;

  // Ask for the relay outputs rather than trusting a capability flag: plenty of
  // devices advertise deviceIO and expose no relays, and vice versa.
  const relays = await readRelayOutputs(cam, config.onvifTimeoutMs);
  capabilities.relayOutputs = relays.length;

  const ptz = capabilities.ptz ? await readPtzCapabilities(cam, profiles, ctx) : null;
  // A device can advertise the PTZ service and still have no movable node.
  if (ptz === null) capabilities.ptz = false;

  return {
    cam,
    device: {
      manufacturer: info?.manufacturer ?? null,
      model: info?.model ?? null,
      firmware: info?.firmwareVersion ?? null,
      serial: info?.serialNumber ?? null,
      hardwareId: info?.hardwareId ?? null,
      ...clock,
    },
    capabilities,
    profiles,
    profileMap,
    sources,
    isMultiChannel,
    ptz,
  };
}

/** WS-Discovery multicast probe. Never blocks longer than timeoutMs. */
export function discoverDevices(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try { onvif.Discovery.removeAllListeners('device'); } catch { /* ignore */ }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs + 250);

    const onDevice = (probe, rinfo) => {
      try {
        const xaddrs = asArray(probe?.probeMatches?.probeMatch?.XAddrs ?? probe?.XAddrs)
          .flatMap((x) => String(x).split(/\s+/))
          .filter(Boolean);
        const first = xaddrs[0];
        const url = first ? new URL(first) : null;
        const host = url?.hostname ?? rinfo?.address;
        if (!host || found.has(host)) return;

        const scopes = String(probe?.probeMatches?.probeMatch?.Scopes ?? '');
        const pick = (key) => {
          const m = scopes.match(new RegExp(`onvif://www\\.onvif\\.org/${key}/([^\\s]+)`));
          return m ? decodeURIComponent(m[1]) : null;
        };

        found.set(host, {
          host,
          port: url?.port ? Number(url.port) : 80,
          name: [pick('name'), pick('hardware')].filter(Boolean).join(' ') || host,
          hardware: pick('hardware'),
          xaddrs,
        });
      } catch { /* a malformed probe response must not kill discovery */ }
    };

    try {
      onvif.Discovery.on('device', onDevice);
      onvif.Discovery.probe({ timeout: timeoutMs }, () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}
