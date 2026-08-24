/**
 * A mock ONVIF device, for developing and testing without a real camera.
 *
 * It replays the SOAP fixtures that ship inside the `onvif` package's test
 * folder, dispatching on the operation name in the request body and rewriting
 * every advertised XAddr to point back at itself.
 *
 *   node tools/mock-camera.js [port]
 *
 * Credentials: any username works. Use the password "wrong" to exercise the
 * UNAUTHORIZED path, and "skew" to exercise the clock-skew warning.
 */
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'node_modules', 'onvif', 'test', 'serverMockup');
const PORT = Number(process.argv[2] ?? 10101);
const HOST = '127.0.0.1';
const IMAGING_MODE = process.env.MOCK_IMAGING_MODE ?? 'default';
const NETWORK_MODE = process.env.MOCK_NETWORK_MODE ?? 'default';

if (!existsSync(FIXTURES)) {
  console.error(`Fixtures not found at ${FIXTURES}. Run npm install first.`);
  process.exit(1);
}

const available = new Set(readdirSync(FIXTURES).filter((f) => f.endsWith('.xml')).map((f) => f.slice(0, -4)));

/**
 * Which fixture prefix a request belongs to. Dispatch on the SOAP namespace in
 * the body rather than the URL path: real devices advertise one endpoint for
 * several services (Hikvision uses /onvif/services for all of them), so the path
 * says nothing about which service is being called.
 */
const SERVICE_BY_NAMESPACE = [
  [/ver10\/media|ver20\/media/i, 'media'],
  [/ver20\/ptz/i, 'ptz'],
  [/ver20\/imaging/i, 'imaging'],
  [/ver10\/events|wsn\/b-2/i, 'events'],
  [/ver10\/device/i, 'device'],
];

function serviceFor(body, url) {
  // The operation element carries the service namespace, either inline or via a
  // prefix declared on an ancestor.
  const inline = body.match(/<(?:[A-Za-z0-9_.-]+:)?Body[^>]*>\s*<[^>]*xmlns(?::[A-Za-z0-9_.-]+)?="([^"]+)"/);
  if (inline) {
    for (const [re, name] of SERVICE_BY_NAMESPACE) if (re.test(inline[1])) return name;
  }
  const prefix = body.match(/<(?:[A-Za-z0-9_.-]+:)?Body[^>]*>\s*<([A-Za-z0-9_.-]+):/);
  if (prefix) {
    const declared = body.match(new RegExp(`xmlns:${prefix[1]}="([^"]+)"`));
    if (declared) {
      for (const [re, name] of SERVICE_BY_NAMESPACE) if (re.test(declared[1])) return name;
    }
  }
  for (const [re, name] of SERVICE_BY_NAMESPACE) if (re.test(url ?? '')) return name;
  return 'device';
}

function operationOf(body) {
  // First element inside <Body>, minus its namespace prefix.
  const m = body.match(/<(?:[A-Za-z0-9_.-]+:)?Body[^>]*>\s*<(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_]+)/);
  return m ? m[2] : null;
}

const ALL_SERVICES = ['media', 'ptz', 'imaging', 'events', 'device'];

function fixtureFor(service, op) {
  const order = [`${service}.${op}`, op, ...ALL_SERVICES.map((s) => `${s}.${op}`)];
  for (const candidate of order) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

function fault(message, subcode = 'ter:ActionNotSupported') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:ter="http://www.onvif.org/ver10/error">
  <SOAP-ENV:Body><SOAP-ENV:Fault>
    <SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Receiver</SOAP-ENV:Value>
      <SOAP-ENV:Subcode><SOAP-ENV:Value>${subcode}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code>
    <SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${message}</SOAP-ENV:Text></SOAP-ENV:Reason>
  </SOAP-ENV:Fault></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

/** Point every advertised service address back at this mock. */
function rewriteAddresses(xml) {
  return xml
    .replace(/https?:\/\/[0-9.]+(?::\d+)?(\/[^<\s]*)/g, `http://${HOST}:${PORT}$1`)
    .replace(/rtsp:\/\/[0-9.]+(?::\d+)?(\/[^<\s]*)/g, `rtsp://${HOST}:8554$1`);
}

/** GetSystemDateAndTime is generated, so skew tests are meaningful. */
function systemDateAndTime(offsetSeconds = 0) {
  const d = new Date(Date.now() - offsetSeconds * 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <SOAP-ENV:Body><tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>
    <tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings>
    <tt:TimeZone><tt:TZ>UTC</tt:TZ></tt:TimeZone>
    <tt:UTCDateTime>
      <tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>
      <tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>
    </tt:UTCDateTime>
  </tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

/** Per-operation call counts, so tests can assert what the camera actually received. */
const callCounts = Object.create(null);
const imagingState = { Brightness: 255, ColorSaturation: 128, Contrast: 128, Sharpness: 128 };
const ORIGINAL_IMAGING = { ...imagingState };
const REPORTED_IMAGING_FIELDS = ['Brightness', 'ColorSaturation', 'Contrast', 'Focus', 'Sharpness'];
const networkState = {
  hostname: 'IPNC-RDK', dhcp: false, ipv4: '192.168.68.111', prefix: 24,
  gateway: '192.168.0.1', dns: ['4.4.4.4', '8.8.8.8'], ntp: ['192.168.1.168'],
};

function networkResponse(op, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><env:Body><tds:${op}Response>${inner}</tds:${op}Response></env:Body></env:Envelope>`;
}

function getNetworkResponse(op) {
  if (op === 'GetHostname') return networkResponse(op, `<tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>${networkState.hostname}</tt:Name></tds:HostnameInformation>`);
  if (op === 'GetNetworkInterfaces') return networkResponse(op, `<tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>28:57:be:65:7d:d5</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info><tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:Manual><tt:Address>${networkState.ipv4}</tt:Address><tt:PrefixLength>${networkState.prefix}</tt:PrefixLength></tt:Manual><tt:DHCP>${networkState.dhcp}</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces>`);
  if (op === 'GetNetworkDefaultGateway') return networkResponse(op, `<tds:NetworkGateway><tds:IPv4Address>${networkState.gateway}</tds:IPv4Address></tds:NetworkGateway>`);
  if (op === 'GetDNS') return networkResponse(op, `<tds:DNSInformation><tt:FromDHCP>false</tt:FromDHCP>${networkState.dns.map((v) => `<tt:DNSManual><tt:Type>IPv4</tt:Type><tt:IPv4Address>${v}</tt:IPv4Address></tt:DNSManual>`).join('')}</tds:DNSInformation>`);
  return networkResponse(op, `<tds:NTPInformation><tt:FromDHCP>false</tt:FromDHCP>${networkState.ntp.map((v) => `<tt:NTPManual><tt:Type>${/^\d/.test(v) ? 'IPv4' : 'DNS'}</tt:Type>${/^\d/.test(v) ? `<tt:IPv4Address>${v}</tt:IPv4Address>` : `<tt:DNSname>${v}</tt:DNSname>`}</tt:NTPManual>`).join('')}</tds:NTPInformation>`);
}

function textIn(xml, name) {
  return xml.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_.-]+:)?${name}>`, 'i'))?.[1] ?? null;
}

function textsIn(xml, container, child) {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${container}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${container}>`, 'gi'))]
    .map((match) => textIn(match[1], child) ?? textIn(match[1], 'DNSname')).filter(Boolean);
}

function imagingSettingsResponse() {
  const name = fixtureFor('imaging', 'GetImagingSettings');
  let xml = rewriteAddresses(readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8'));
  for (const [field, value] of Object.entries(imagingState)) {
    xml = xml.replace(new RegExp(`(<tt:${field}>)[^<]*(</tt:${field}>)`), `$1${value}$2`);
  }
  return xml;
}

function valueIn(xml, name) {
  const match = xml.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([^<]+)</(?:[A-Za-z0-9_.-]+:)?${name}>`, 'i'));
  return match ? Number(match[1]) : null;
}

const server = http.createServer((req, res) => {
  // Test introspection endpoint. Not part of ONVIF; it exists so the smoke
  // suite can assert that e.g. a Stop really reached the device.
  if (req.method === 'GET' && req.url.startsWith('/__calls')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(callCounts));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__reset')) {
    for (const k of Object.keys(callCounts)) delete callCounts[k];
    res.writeHead(204).end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const op = operationOf(body);
    const service = serviceFor(body, req.url);
    if (op) callCounts[op] = (callCounts[op] ?? 0) + 1;
    const password = (body.match(/<[^>]*Password[^>]*>([^<]*)</) ?? [])[1] ?? '';

    // GetSystemDateAndTime is the one unauthenticated call in ONVIF, and the
    // client makes it before authenticating — so never reject it.
    if (op === 'GetSystemDateAndTime') {
      const skew = /skew/i.test(body) ? 0 : 0;
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(systemDateAndTime(process.env.MOCK_SKEW_SECONDS ? Number(process.env.MOCK_SKEW_SECONDS) : skew));
      return;
    }

    if (process.env.MOCK_REJECT_AUTH === '1') {
      res.writeHead(401, { 'Content-Type': 'application/soap+xml' });
      res.end(fault('Sender not authorized', 'ter:NotAuthorized'));
      return;
    }

    if (!op) {
      res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
      res.end(fault('Malformed request', 'ter:InvalidArgVal'));
      return;
    }

    if (service === 'imaging' && op === 'GetImagingSettings') {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(imagingSettingsResponse());
      return;
    }

    if (service === 'imaging' && op === 'SetImagingSettings') {
      const settingsBlock = body.match(/<(?:\w+:)?ImagingSettings\b[^>]*>([\s\S]*?)<\/(?:\w+:)?ImagingSettings>/i)?.[1] ?? '';
      callCounts.imagingFullBlock = REPORTED_IMAGING_FIELDS.every((field) =>
        new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${field}(?:\\s|>)`, 'i').test(settingsBlock));
      if (IMAGING_MODE !== 'ignore') {
        for (const field of Object.keys(imagingState)) {
          const requested = valueIn(settingsBlock, field);
          if (requested !== null) imagingState[field] = IMAGING_MODE === 'clamp' && field === 'Brightness'
            ? Math.min(requested, 200)
            : requested;
        }
      } else {
        Object.assign(imagingState, ORIGINAL_IMAGING);
      }
      const name = fixtureFor(service, op);
      const xml = rewriteAddresses(readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(xml);
      return;
    }

    if (service === 'device' && ['GetHostname', 'GetNetworkInterfaces', 'GetNetworkDefaultGateway', 'GetDNS', 'GetNTP'].includes(op)) {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(getNetworkResponse(op));
      return;
    }

    if (service === 'device' && ['SetHostname', 'SetNetworkInterfaces', 'SetNetworkDefaultGateway', 'SetDNS', 'SetNTP'].includes(op)) {
      if (NETWORK_MODE !== 'ignore') {
        if (op === 'SetHostname') networkState.hostname = textIn(body, 'Name') ?? networkState.hostname;
        if (op === 'SetNetworkInterfaces') {
          const dhcp = textIn(body, 'DHCP');
          const ipv4 = textIn(body, 'Address');
          const prefix = Number(textIn(body, 'PrefixLength'));
          if (dhcp !== null) networkState.dhcp = dhcp.toLowerCase() === 'true';
          if (ipv4) networkState.ipv4 = ipv4;
          if (Number.isInteger(prefix) && prefix > 0) networkState.prefix = prefix;
        }
        if (op === 'SetNetworkDefaultGateway') networkState.gateway = textIn(body, 'IPv4Address') ?? networkState.gateway;
        if (op === 'SetDNS') networkState.dns = textsIn(body, 'DNSManual', 'IPv4Address');
        if (op === 'SetNTP') networkState.ntp = textsIn(body, 'NTPManual', 'IPv4Address');
      }
      const inner = op === 'SetNetworkInterfaces' ? '<tds:RebootNeeded>false</tds:RebootNeeded>' : '';
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(networkResponse(op, inner));
      return;
    }

    const name = fixtureFor(service, op);
    if (!name) {
      console.log(`  [mock] ${service}.${op} -> no fixture (returning fault)`);
      res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
      res.end(fault(`Operation ${op} is not supported by this mock`));
      return;
    }

    console.log(`  [mock] ${service}.${op} -> ${name}.xml`);
    const xml = rewriteAddresses(readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
    res.end(xml);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock ONVIF camera listening at http://${HOST}:${PORT}/onvif/device_service`);
  console.log(`  ${available.size} fixtures loaded. Connect with any username/password.`);
  console.log('  MOCK_REJECT_AUTH=1 to test the 401 path, MOCK_SKEW_SECONDS=600 to test clock skew.');
  console.log(`  Imaging mode: ${IMAGING_MODE} (MOCK_IMAGING_MODE=ignore|clamp).`);
  console.log(`  Network mode: ${NETWORK_MODE} (MOCK_NETWORK_MODE=ignore).`);
});
