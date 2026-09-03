import { AppError, mapOnvifError } from '../errors.js';
import { withGovernor } from '../device/governor.js';
import { readDevice } from './device.js';

const DEV10 = 'http://www.onvif.org/ver10/device/wsdl';
const SCHEMA = 'http://www.onvif.org/ver10/schema';
const FIELDS = new Set(['hostname', 'dhcp', 'ipv4', 'prefix', 'gateway', 'dns', 'ntp']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value) => String(value).replace(/[<>&"']/g, (ch) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
));

function bad(message, hint = null) {
  throw new AppError('BAD_REQUEST', message, hint);
}

export function isIPv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part);
}

function isHostname(value) {
  return typeof value === 'string' && value.length <= 253 && value.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function validateEndpoint(value, field) {
  const looksLikeIPv4 = typeof value === 'string' && /^\d+(?:\.\d+){3}$/.test(value);
  if (typeof value !== 'string' || (looksLikeIPv4 ? !isIPv4(value) : !isHostname(value))) {
    bad(`Every ${field} entry must be a valid IPv4 address or hostname.`);
  }
}

export function validateNetworkSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    bad('"settings" must be an object.');
  }
  const keys = Object.keys(settings);
  if (keys.length === 0) bad('At least one network setting is required.');
  for (const key of keys) if (!FIELDS.has(key)) bad(`Unknown network setting "${key}".`);
  if ('hostname' in settings) {
    if (typeof settings.hostname !== 'string' || !settings.hostname.trim()) bad('Hostname cannot be empty.');
    if (!isHostname(settings.hostname.trim())) bad('Hostname must contain only valid DNS hostname labels.');
  }
  if ('dhcp' in settings && typeof settings.dhcp !== 'boolean') bad('DHCP must be true or false.');
  for (const field of ['ipv4', 'gateway']) {
    if (field in settings && !isIPv4(settings[field])) bad(`"${field}" must be a valid IPv4 address.`);
  }
  if ('prefix' in settings && (!Number.isInteger(settings.prefix) || settings.prefix < 1 || settings.prefix > 32)) {
    bad('"prefix" must be an integer from 1 to 32.');
  }
  for (const field of ['dns', 'ntp']) {
    if (field in settings) {
      if (!Array.isArray(settings[field])) bad(`"${field}" must be a list.`);
      settings[field].forEach((entry) => validateEndpoint(entry, field.toUpperCase()));
    }
  }
  if (settings.dhcp === false && (('ipv4' in settings) !== ('prefix' in settings))) {
    bad('A static IPv4 address and prefix length must be supplied together.');
  }
  return {
    ...settings,
    ...('hostname' in settings ? { hostname: settings.hostname.trim() } : {}),
  };
}

/**
 * Hand-built SOAP bypasses the `onvif` library, so it must be routed through
 * the per-host governor explicitly — these are the paths a probe storm would
 * otherwise escape through (GOVERNOR.md).
 */
function rawRequest(cam, body, timeoutMs) {
  return withGovernor(cam?.hostname, () => rawRequestUngoverned(cam, body, timeoutMs));
}

function rawRequestUngoverned(cam, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError('DEVICE_TIMEOUT', 'The device did not answer the network request in time.'));
    }, timeoutMs ?? 10000);
    try {
      cam._request({ service: 'device', body: cam._envelopeHeader() + body + cam._envelopeFooter() }, (err, data) => {
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

export async function readNetwork(session) {
  const network = (await readDevice(session)).network;
  // The legacy device block sourced this top-level value from GetHostname.
  // Network editing needs the interface's actual DHCP state while preserving
  // the established response shape.
  return { ...network, dhcp: network.interfaces?.[0]?.dhcp ?? network.dhcp };
}

function endpointXml(tag, value) {
  if (isIPv4(value)) {
    return `<${tag}><Type xmlns="${SCHEMA}">IPv4</Type><IPv4Address xmlns="${SCHEMA}">${esc(value)}</IPv4Address></${tag}>`;
  }
  return `<${tag}><Type xmlns="${SCHEMA}">DNS</Type><DNSname xmlns="${SCHEMA}">${esc(value)}</DNSname></${tag}>`;
}

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);
}

function fieldApplied(field, requested, _before, after) {
  const firstAfter = after.interfaces?.[0] ?? {};
  const actual = field === 'ipv4' || field === 'prefix' ? firstAfter[field] : after[field];
  if (field === 'dns' || field === 'ntp') return sameList(actual, requested);
  return actual === requested;
}

export async function writeNetwork(session, patch) {
  const settings = validateNetworkSettings(patch);
  const before = await readNetwork(session);
  const iface = before.interfaces?.find((item) => item.enabled) ?? before.interfaces?.[0];
  const interfaceFields = ['dhcp', 'ipv4', 'prefix'].filter((field) => field in settings);
  if (interfaceFields.length && !iface) throw new AppError('UNSUPPORTED', 'This device reported no writable network interface.');

  try {
    if ('hostname' in settings) {
      await rawRequest(session.cam, `<SetHostname xmlns="${DEV10}"><Name>${esc(settings.hostname)}</Name></SetHostname>`, session.timeoutMs);
    }
    if ('dns' in settings) {
      await rawRequest(session.cam, `<SetDNS xmlns="${DEV10}"><FromDHCP>false</FromDHCP>${settings.dns.map((v) => endpointXml('DNSManual', v)).join('')}</SetDNS>`, session.timeoutMs);
    }
    if ('ntp' in settings) {
      await rawRequest(session.cam, `<SetNTP xmlns="${DEV10}"><FromDHCP>false</FromDHCP>${settings.ntp.map((v) => endpointXml('NTPManual', v)).join('')}</SetNTP>`, session.timeoutMs);
    }
    if ('gateway' in settings) {
      await rawRequest(session.cam, `<SetNetworkDefaultGateway xmlns="${DEV10}"><IPv4Address>${esc(settings.gateway)}</IPv4Address></SetNetworkDefaultGateway>`, session.timeoutMs);
    }
    // Apply the interface last: changing its address can immediately sever the
    // current transport, so all independent writes must already be complete.
    if (interfaceFields.length) {
      const dhcp = settings.dhcp ?? iface.dhcp;
      const ipv4 = settings.ipv4 ?? iface.ipv4;
      const prefix = settings.prefix ?? iface.prefix;
      if (!dhcp && (!isIPv4(ipv4) || !Number.isInteger(prefix))) {
        bad('The camera did not report a usable current static address; supply both IPv4 and prefix.');
      }
      const manual = ipv4 && prefix
        ? `<Manual><Address>${esc(ipv4)}</Address><PrefixLength>${prefix}</PrefixLength></Manual>` : '';
      await rawRequest(session.cam,
        `<SetNetworkInterfaces xmlns="${DEV10}"><InterfaceToken>${esc(iface.name)}</InterfaceToken>` +
        `<NetworkInterface><Enabled xmlns="${SCHEMA}">true</Enabled><IPv4 xmlns="${SCHEMA}">` +
        `<Enabled>true</Enabled>${manual}<DHCP>${dhcp}</DHCP></IPv4></NetworkInterface></SetNetworkInterfaces>`,
        session.timeoutMs);
    }
  } catch (err) {
    throw mapOnvifError(err, session.ctx);
  }

  let after = before;
  for (const delayMs of [150, 400, 900]) {
    await wait(delayMs);
    try { after = await readNetwork(session); } catch { /* relocation may interrupt confirmation */ }
    if (Object.entries(settings).every(([field, value]) => fieldApplied(field, value, before, after))) break;
  }
  after.applied = Object.fromEntries(Object.entries(settings).map(([field, value]) =>
    [field, fieldApplied(field, value, before, after)]));

  const relocating = interfaceFields.length > 0 || 'gateway' in settings;
  const expectedAddress = settings.dhcp === true ? null : (settings.ipv4 ?? iface?.ipv4 ?? session.host ?? null);
  return {
    ...after,
    relocation: relocating ? { expected: true, address: expectedAddress } : { expected: false, address: null },
  };
}
