import { AppError, mapOnvifError } from '../errors.js';
import { withGovernor } from '../device/governor.js';
import { callCam, tryCam, asArray, num } from './util.js';

const DEV10 = 'http://www.onvif.org/ver10/device/wsdl';
const esc = (v) => String(v).replace(/[<>&"']/g, (ch) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
));

/**
 * Hand-built SOAP bypasses the `onvif` library, so it must be routed through
 * the per-host governor explicitly — these are the paths a probe storm would
 * otherwise escape through (GOVERNOR.md).
 */
function rawRequest(cam, service, body, timeoutMs) {
  return withGovernor(cam?.hostname, () => rawRequestUngoverned(cam, service, body, timeoutMs));
}

function rawRequestUngoverned(cam, service, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', 'The device did not answer in time.'));
    }, timeoutMs);
    try {
      cam._request({ service, body: cam._envelopeHeader() + body + cam._envelopeFooter() }, (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(data);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

function readInterfaces(raw) {
  return asArray(raw).map((i) => {
    const ipv4 = i?.IPv4?.config ?? i?.ipv4?.config ?? {};
    const manual = asArray(ipv4.manual)[0];
    const fromDhcp = ipv4.fromDHCP;
    const addr = manual ?? fromDhcp ?? {};
    return {
      name: i?.info?.name ?? i?.$?.token ?? null,
      mac: i?.info?.hwAddress ?? null,
      enabled: Boolean(i?.enabled),
      dhcp: Boolean(ipv4.DHCP ?? ipv4.dhcp),
      ipv4: addr?.address ?? null,
      prefix: num(addr?.prefixLength),
      mtu: num(i?.info?.MTU),
    };
  });
}

/**
 * Relay outputs are not exposed by the `onvif` library at all, so both the read
 * and the write go out as hand-built SOAP against the device service. These are
 * the alarm-out contacts used for gates, sirens and lights.
 */
export async function readRelayOutputs(cam, timeoutMs) {
  try {
    const data = await rawRequest(cam, 'device', `<GetRelayOutputs xmlns="${DEV10}"/>`, timeoutMs);
    const body = data?.[0]?.getRelayOutputsResponse?.[0]?.relayOutput ?? [];
    return asArray(body).map((r) => {
      const props = r?.properties?.[0] ?? {};
      return {
        token: r?.$?.token ?? null,
        mode: props.mode?.[0] ?? 'Bistable',
        delayTime: props.delayTime?.[0] ?? null,
        idleState: props.idleState?.[0] ?? 'closed',
        state: 'unknown',
      };
    }).filter((r) => r.token);
  } catch {
    // Most fixed cameras have no relay service; absence is normal, not an error.
    return [];
  }
}

export async function setRelayOutput(cam, { token, state }, timeoutMs) {
  const logical = String(state).toLowerCase() === 'active' ? 'active' : 'inactive';
  try {
    await rawRequest(
      cam, 'device',
      `<SetRelayOutputState xmlns="${DEV10}">` +
        `<RelayOutputToken>${esc(token)}</RelayOutputToken>` +
        `<LogicalState>${logical}</LogicalState>` +
      '</SetRelayOutputState>',
      timeoutMs,
    );
  } catch (err) {
    throw mapOnvifError(err);
  }
  return logical;
}

export async function readDevice(session) {
  const cam = session.cam;
  const ctx = session.ctx;

  const [info, interfaces, dns, ntp, gateway, dateTime, relays] = await Promise.all([
    tryCam(cam, 'getDeviceInformation', undefined, null, { ctx }),
    tryCam(cam, 'getNetworkInterfaces', undefined, null, { ctx }),
    tryCam(cam, 'getDNS', undefined, null, { ctx }),
    tryCam(cam, 'getNTP', undefined, null, { ctx }),
    tryCam(cam, 'getNetworkDefaultGateway', undefined, null, { ctx }),
    tryCam(cam, 'getSystemDateAndTime', undefined, null, { ctx }),
    readRelayOutputs(cam, session.timeoutMs),
  ]);

  const hostname = await tryCam(cam, 'getHostname', undefined, null, { ctx });

  const localTime = new Date();
  let deviceTime = null;
  const utc = dateTime?.UTCDateTime ?? dateTime?.utcDateTime;
  if (utc?.date && utc?.time) {
    deviceTime = new Date(Date.UTC(
      num(utc.date.year, 1970), num(utc.date.month, 1) - 1, num(utc.date.day, 1),
      num(utc.time.hour, 0), num(utc.time.minute, 0), num(utc.time.second, 0),
    ));
  }

  return {
    info: {
      manufacturer: info?.manufacturer ?? session.device.manufacturer,
      model: info?.model ?? session.device.model,
      firmware: info?.firmwareVersion ?? session.device.firmware,
      serial: info?.serialNumber ?? session.device.serial,
      hardwareId: info?.hardwareId ?? session.device.hardwareId,
    },
    network: {
      hostname: hostname?.name ?? null,
      dhcp: Boolean(hostname?.fromDHCP),
      interfaces: readInterfaces(interfaces),
      dns: asArray(dns?.DNSFromDHCP ?? dns?.DNSManual)
        .map((d) => d?.IPv4Address ?? d?.ipv4Address).filter(Boolean),
      ntp: asArray(ntp?.NTPFromDHCP ?? ntp?.NTPManual)
        .map((n) => n?.IPv4Address ?? n?.ipv4Address ?? n?.DNSname).filter(Boolean),
      gateway: asArray(gateway?.IPv4Address ?? gateway?.ipv4Address)[0] ?? null,
    },
    time: {
      deviceTime: deviceTime && !Number.isNaN(deviceTime.getTime()) ? deviceTime.toISOString() : null,
      localTime: localTime.toISOString(),
      skewSeconds: deviceTime && !Number.isNaN(deviceTime.getTime())
        ? Number(((localTime.getTime() - deviceTime.getTime()) / 1000).toFixed(1))
        : null,
      timezone: dateTime?.timeZone?.TZ ?? null,
      ntpEnabled: String(dateTime?.dateTimeType ?? '').toUpperCase() === 'NTP',
    },
    relayOutputs: relays,
  };
}

export async function reboot(session) {
  const message = await callCam(session.cam, 'systemReboot', undefined, { ctx: session.ctx });
  return typeof message === 'string' ? message : 'Reboot command accepted.';
}

/** Push the server clock to the device. This is the fix for the digest-auth
 *  failures that clock skew causes, so it is worth having as a one-click action. */
export async function syncTime(session) {
  const now = new Date();
  await callCam(session.cam, 'setSystemDateAndTime', {
    dateTime: now,
    dateTimeType: 'Manual',
    daylightSavings: false,
    timezone: 'UTC',
  }, { ctx: session.ctx });
}
