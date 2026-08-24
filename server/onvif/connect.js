import onvif from 'onvif';
import { AppError, mapOnvifError } from '../errors.js';
import { config } from '../config.js';
import { callCam, tryCam, asArray, num, authorizeUri } from './util.js';
import { describeProfiles } from './media.js';
import { readPtzCapabilities } from './ptz.js';

const { Cam } = onvif;

const PRIVATE_DENY = [
  // Cloud instance metadata. This app is run from hosts inside AWS, so an
  // operator-supplied "camera host" is a live SSRF vector.
  /^169\.254\.169\.254$/,
  /^metadata\.google\.internal$/i,
  /^100\.100\.100\.200$/,
];

export function assertSafeHost(host) {
  if (typeof host !== 'string' || !host.trim()) {
    throw new AppError('BAD_REQUEST', 'A camera host or IP address is required.');
  }
  const trimmed = host.trim();
  if (PRIVATE_DENY.some((re) => re.test(trimmed))) {
    throw new AppError('BAD_REQUEST', 'That address is not a camera.',
      'Cloud metadata endpoints are blocked because this app proxies requests on your behalf.');
  }
  if (/[\s/\\?#]/.test(trimmed)) {
    throw new AppError('BAD_REQUEST', 'Enter just the host or IP address, without a URL path.');
  }
  return trimmed;
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

function readCapabilityMatrix(cam) {
  const caps = cam.capabilities ?? {};
  const services = asArray(cam.services);
  const hasNamespace = (fragment) =>
    services.some((s) => typeof s?.namespace === 'string' && s.namespace.includes(fragment));

  return {
    media: Boolean(caps.media?.XAddr ?? caps.Media?.XAddr ?? cam.media),
    media2: hasNamespace('ver20/media'),
    ptz: Boolean(caps.PTZ?.XAddr ?? caps.ptz?.XAddr),
    imaging: Boolean(caps.imaging?.XAddr ?? caps.Imaging?.XAddr),
    events: Boolean(caps.events?.XAddr ?? caps.Events?.XAddr),
    analytics: Boolean(caps.analytics?.XAddr ?? caps.Analytics?.XAddr) || hasNamespace('analytics'),
    recording: hasNamespace('recording'),
    relayOutputs: num(caps.device?.IO?.relayOutputs ?? caps.Device?.IO?.RelayOutputs, 0) ?? 0,
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

  const utc = systemDateAndTime?.UTCDateTime ?? systemDateAndTime?.utcDateTime;
  if (utc?.date && utc?.time) {
    deviceTime = new Date(Date.UTC(
      num(utc.date.year, 1970), num(utc.date.month, 1) - 1, num(utc.date.day, 1),
      num(utc.time.hour, 0), num(utc.time.minute, 0), num(utc.time.second, 0),
    ));
  } else if (systemDateAndTime?.dateTime instanceof Date) {
    deviceTime = systemDateAndTime.dateTime;
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
  const safeHost = assertSafeHost(host);
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
