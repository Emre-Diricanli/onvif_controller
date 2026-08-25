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
  [/ver10\/recording/i, 'recording'],
  [/ver10\/replay/i, 'replay'],
  [/ver10\/search/i, 'search'],
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
/**
 * Mutable video-encoder state.
 *
 * Modelled on the operator's real camera: two profiles whose resolution sets are
 * DISJOINT. A UI that reuses one profile's option list for the other will offer
 * 352x288 on the main stream, which the device rejects — so the mock has to be
 * able to catch that.
 */
const ENCODER_MODE = process.env.MOCK_ENCODER_MODE ?? 'default';

const ENCODER_RESOLUTIONS = {
  VideoEncoder: [
    { width: 2880, height: 1616 }, { width: 2560, height: 1440 },
    { width: 2304, height: 1296 }, { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ],
  VideoSubEncoder: [
    { width: 704, height: 576 }, { width: 800, height: 448 },
    { width: 640, height: 480 }, { width: 640, height: 360 },
    { width: 352, height: 288 },
  ],
};

const encoderState = {
  VideoEncoder:    { name: 'MainStream', encoding: 'H265', width: 2880, height: 1616, fps: 30, bitrate: 4096, govLength: 50 },
  VideoSubEncoder: { name: 'SubStream',  encoding: 'H265', width: 640,  height: 480,  fps: 30, bitrate: 512,  govLength: 50 },
};
const ORIGINAL_ENCODER = JSON.parse(JSON.stringify(encoderState));

/** Which encoder configuration belongs to a given media profile. */
function encoderTokenForProfile(profileToken) {
  return /sub/i.test(profileToken ?? '') ? 'VideoSubEncoder' : 'VideoEncoder';
}

function encoderConfigXml(token) {
  const c = encoderState[token];
  return `<trt:Configurations token="${token}">`
    + `<tt:Name>${c.name}</tt:Name><tt:UseCount>1</tt:UseCount>`
    + `<tt:Encoding>${c.encoding}</tt:Encoding>`
    + `<tt:Resolution><tt:Width>${c.width}</tt:Width><tt:Height>${c.height}</tt:Height></tt:Resolution>`
    + `<tt:Quality>4</tt:Quality>`
    + `<tt:RateControl><tt:FrameRateLimit>${c.fps}</tt:FrameRateLimit>`
    + `<tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>${c.bitrate}</tt:BitrateLimit></tt:RateControl>`
    + `<tt:H264><tt:GovLength>${c.govLength}</tt:GovLength><tt:H264Profile>Main</tt:H264Profile></tt:H264>`
    + `</trt:Configurations>`;
}

function soapEnvelope(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
<SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function encoderOptionsXml(token) {
  const list = ENCODER_RESOLUTIONS[token] ?? ENCODER_RESOLUTIONS.VideoEncoder;
  const res = list.map((r) => `<tt:ResolutionsAvailable><tt:Width>${r.width}</tt:Width><tt:Height>${r.height}</tt:Height></tt:ResolutionsAvailable>`).join('');
  const block = (name) => `<tt:${name}>${res}`
    + `<tt:GovLengthRange><tt:Min>1</tt:Min><tt:Max>100</tt:Max></tt:GovLengthRange>`
    + `<tt:FrameRateRange><tt:Min>1</tt:Min><tt:Max>30</tt:Max></tt:FrameRateRange>`
    + `<tt:EncodingIntervalRange><tt:Min>1</tt:Min><tt:Max>1</tt:Max></tt:EncodingIntervalRange>`
    + `</tt:${name}>`;
  return soapEnvelope('<trt:GetVideoEncoderConfigurationOptionsResponse><trt:Options>'
    + `<tt:QualityRange><tt:Min>1</tt:Min><tt:Max>6</tt:Max></tt:QualityRange>`
    + block('H264') + block('H265')
    + '</trt:Options></trt:GetVideoEncoderConfigurationOptionsResponse>');
}

/**
 * Multi-channel (DVR / NVR) emulation.
 *
 * MOCK_CHANNELS=N makes this device report N video sources and 2*N media
 * profiles, the way a recorder does. Default 1, which replays the original
 * single-camera fixtures unchanged so every existing test keeps its meaning.
 *
 * Channel 1 deliberately gets PTZ and imaging while later channels vary, because
 * the failure this whole feature exists to prevent is a per-channel setting
 * silently landing on channel 1.
 */
const CHANNELS = Math.max(1, Number(process.env.MOCK_CHANNELS ?? 1));

/** Per-channel imaging, so a write to the wrong channel is detectable. */
const channelImaging = Array.from({ length: CHANNELS }, () => ({
  Brightness: 128, ColorSaturation: 128, Contrast: 128, Sharpness: 128,
}));

const chSourceToken = (i) => `VideoSource_${i + 1}`;
const chMainProfile = (i) => `Profile_ch${i + 1}_main`;
const chSubProfile  = (i) => `Profile_ch${i + 1}_sub`;
/** Channel 1 has PTZ; every third channel after that does not. */
const chHasPtz = (i) => i === 0 || (i % 3 !== 2);

function multiVideoSourcesXml() {
  const sources = Array.from({ length: CHANNELS }, (_, i) =>
    `<trt:VideoSources token="${chSourceToken(i)}">`
    + `<tt:Framerate>25</tt:Framerate>`
    + `<tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution>`
    + `</trt:VideoSources>`).join('');
  return soapEnvelope(`<trt:GetVideoSourcesResponse>${sources}</trt:GetVideoSourcesResponse>`);
}

function profileXml(i, sub) {
  const token = sub ? chSubProfile(i) : chMainProfile(i);
  const name = `Channel ${i + 1} ${sub ? 'Sub' : 'Main'}`;
  const w = sub ? 640 : 1920;
  const h = sub ? 480 : 1080;
  return `<trt:Profiles token="${token}" fixed="true">`
    + `<tt:Name>${name}</tt:Name>`
    + `<tt:VideoSourceConfiguration token="VideoSourceConfig_${i + 1}">`
    + `<tt:Name>VideoSourceConfig ${i + 1}</tt:Name><tt:UseCount>2</tt:UseCount>`
    + `<tt:SourceToken>${chSourceToken(i)}</tt:SourceToken>`
    + `<tt:Bounds x="0" y="0" width="${w}" height="${h}"/>`
    + `</tt:VideoSourceConfiguration>`
    + `<tt:VideoEncoderConfiguration token="Enc_${i + 1}_${sub ? 'sub' : 'main'}">`
    + `<tt:Name>${name}</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding>`
    + `<tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution>`
    + `<tt:Quality>4</tt:Quality>`
    + `<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit>`
    + `<tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>${sub ? 512 : 4096}</tt:BitrateLimit></tt:RateControl>`
    + `</tt:VideoEncoderConfiguration>`
    + (chHasPtz(i)
        ? `<tt:PTZConfiguration token="PTZConfig_${i + 1}"><tt:Name>PTZ ${i + 1}</tt:Name>`
          + `<tt:UseCount>1</tt:UseCount><tt:NodeToken>PTZNode_${i + 1}</tt:NodeToken></tt:PTZConfiguration>`
        : '')
    + `</trt:Profiles>`;
}

function multiProfilesXml() {
  const all = [];
  for (let i = 0; i < CHANNELS; i += 1) { all.push(profileXml(i, false), profileXml(i, true)); }
  return soapEnvelope(`<trt:GetProfilesResponse>${all.join('')}</trt:GetProfilesResponse>`);
}

/** Which channel a request is talking about, from a source or profile token. */
function channelIndexFor(body) {
  const src = body.match(/VideoSource_(\d+)/);
  if (src) return Number(src[1]) - 1;
  const prof = body.match(/Profile_ch(\d+)_/);
  if (prof) return Number(prof[1]) - 1;
  return null;
}

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

/**
 * Profile G (recording / replay / search) emulation.
 *
 * MOCK_PLAYBACK_MODE=off (default) leaves the device without any Profile G
 * service. 'full' answers the whole probe; 'replay-only' advertises recording
 * and replay but no search; 'broken-search' fails GetRecordingSearchResults so
 * the probe's EndSearch-on-error path is exercised.
 */
const PLAYBACK_MODE = process.env.MOCK_PLAYBACK_MODE ?? 'off';

// Recording source ids deliberately do NOT reuse the media VideoSource_*
// tokens: real recorders keep a separate namespace, and the probe exists to
// report when the two cannot be mapped.
const RECORDINGS = [
  { token: 'Recording_SRC_CH1', sourceId: 'SRC_CH1', name: 'Channel 1', trackToken: 'Track_SRC_CH1_video' },
  { token: 'Recording_SRC_CH2', sourceId: 'SRC_CH2', name: 'Channel 2', trackToken: 'Track_SRC_CH2_video' },
];
const RECORDING_FROM = new Date(Date.now() - 24 * 3600 * 1000);
const RECORDING_UNTIL = new Date();
const iso = (d) => d.toISOString();

/** Each recording covers half the retention window, so spans differ per source. */
function recordingSpan(i) {
  const half = (RECORDING_UNTIL - RECORDING_FROM) / 2;
  return {
    from: new Date(RECORDING_FROM.getTime() + i * half),
    until: new Date(RECORDING_FROM.getTime() + (i + 1) * half),
  };
}

/** Open search sessions, keyed by SearchToken. EndSearch removes its entry. */
const searchSessions = new Map();
let searchSeq = 0;

function playbackSoap(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl" xmlns:trp="http://www.onvif.org/ver10/replay/wsdl" xmlns:tse="http://www.onvif.org/ver10/search/wsdl">
<SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

/** GetServices with the Profile G services appended, XAddrs on this mock. */
function getServicesWithPlayback() {
  const name = fixtureFor('device', 'GetServices');
  const xml = rewriteAddresses(readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8'));
  const service = (ns, xaddr) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace>`
    + `<tds:XAddr>http://${HOST}:${PORT}${xaddr}</tds:XAddr>`
    + `<tds:Version><tt:Major>2</tt:Major><tt:Minor>42</tt:Minor></tds:Version></tds:Service>`;
  const extra = [
    service('http://www.onvif.org/ver10/recording/wsdl', '/onvif/recording_service'),
    service('http://www.onvif.org/ver10/replay/wsdl', '/onvif/replay_service'),
  ];
  if (PLAYBACK_MODE !== 'replay-only') {
    extra.push(service('http://www.onvif.org/ver10/search/wsdl', '/onvif/search_service'));
  }
  return xml.replace('</tds:GetServicesResponse>', `${extra.join('')}</tds:GetServicesResponse>`);
}

const PLAYBACK_CAPABILITIES = {
  recording: '<trc:GetServiceCapabilitiesResponse><trc:Capabilities DynamicRecordings="false" DynamicTracks="false" MaxRecordingJobs="0" Options="false" MetadataRecording="false"/></trc:GetServiceCapabilitiesResponse>',
  replay: '<trp:GetServiceCapabilitiesResponse><trp:Capabilities ReverseReplay="true" ReversePlayback="true" SessionTimeout="PT60S" RTP_RTSP_TCP="true"/></trp:GetServiceCapabilitiesResponse>',
  search: '<tse:GetServiceCapabilitiesResponse><tse:Capabilities MetadataSearch="true" MaxMatchedResults="100"/></tse:GetServiceCapabilitiesResponse>',
};

function recordingSourceXml(r) {
  return `<tt:Source><tt:SourceId>${r.sourceId}</tt:SourceId><tt:Name>${r.name}</tt:Name>`
    + `<tt:Location>Mock rack</tt:Location><tt:Description>Recorded ${r.name}</tt:Description>`
    + `<tt:Address>http://${HOST}:${PORT}</tt:Address></tt:Source>`;
}

function getRecordingsXml() {
  const items = RECORDINGS.map((r) => `<trc:RecordingItem token="${r.token}">`
    + '<tt:RecordingConfiguration>'
    + recordingSourceXml(r)
    + `<tt:Content>${r.name} footage</tt:Content><tt:MaximumRetentionTime>PT24H</tt:MaximumRetentionTime>`
    + `<tt:TrackConfiguration><tt:TrackToken>${r.trackToken}</tt:TrackToken><tt:TrackType>Video</tt:TrackType></tt:TrackConfiguration>`
    + '</tt:RecordingConfiguration>'
    + `<tt:Tracks><tt:Track TrackToken="${r.trackToken}">`
    + `<tt:Configuration><tt:TrackType>Video</tt:TrackType><tt:Description>Video from ${r.name}</tt:Description></tt:Configuration>`
    + '</tt:Track></tt:Tracks>'
    + '</trc:RecordingItem>').join('');
  return playbackSoap(`<trc:GetRecordingsResponse>${items}</trc:GetRecordingsResponse>`);
}

function getRecordingSummaryXml() {
  return playbackSoap('<trc:GetRecordingSummaryResponse><trc:Summary>'
    + `<tt:DataFrom>${iso(RECORDING_FROM)}</tt:DataFrom><tt:DataUntil>${iso(RECORDING_UNTIL)}</tt:DataUntil>`
    + `<tt:NumberRecordings>${RECORDINGS.length}</tt:NumberRecordings>`
    + '</trc:Summary></trc:GetRecordingSummaryResponse>');
}

function recordingSearchResultsXml() {
  const results = RECORDINGS.map((r, i) => {
    const span = recordingSpan(i);
    return '<tse:RecordingInformation>'
      + `<tse:RecordingToken>${r.token}</tse:RecordingToken>`
      + recordingSourceXml(r)
      + `<tt:Content>${r.name} footage</tt:Content>`
      + `<tt:Track TrackToken="${r.trackToken}"><tt:TrackType>Video</tt:TrackType>`
      + `<tt:TimeSpan><tt:StartTime>${iso(span.from)}</tt:StartTime><tt:EndTime>${iso(span.until)}</tt:EndTime></tt:TimeSpan></tt:Track>`
      + '<tt:RecordingStatus>Recorded</tt:RecordingStatus>'
      + '</tse:RecordingInformation>';
  }).join('');
  return playbackSoap('<tse:GetRecordingSearchResultsResponse><tse:ResultList>'
    + '<tse:SearchState>Completed</tse:SearchState>' + results
    + '</tse:ResultList></tse:GetRecordingSearchResultsResponse>');
}

function eventSearchResultsXml() {
  const results = RECORDINGS.map((r, i) => {
    const when = new Date(recordingSpan(i).from.getTime() + 60 * 1000);
    return '<tse:Result>'
      + `<tt:RecordingToken>${r.token}</tt:RecordingToken><tt:TrackToken>${r.trackToken}</tt:TrackToken>`
      + `<tt:Time>${iso(when)}</tt:Time>`
      + '<tt:Event><wsnt:NotificationMessage xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">'
      + '<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>'
      + `<wsnt:Message><tt:Message UtcTime="${iso(when)}"><tt:Source><tt:SimpleItem Name="VideoSourceToken" Value="${r.sourceId}"/></tt:Source><tt:Data><tt:SimpleItem Name="IsMotion" Value="true"/></tt:Data></tt:Message></wsnt:Message>`
      + '</wsnt:NotificationMessage></tt:Event>'
      + '<tt:StartStateEvent>false</tt:StartStateEvent>'
      + '</tse:Result>';
  }).join('');
  return playbackSoap('<tse:GetEventSearchResultsResponse><tse:ResultList>'
    + '<tse:SearchState>Completed</tse:SearchState>' + results
    + '</tse:ResultList></tse:GetEventSearchResultsResponse>');
}

function getReplayUriXml(body) {
  const token = (body.match(/<[^>]*RecordingToken[^>]*>([^<]*)</) ?? [])[1] ?? RECORDINGS[0].token;
  return playbackSoap('<trp:GetReplayUriResponse>'
    + `<trp:Uri>rtsp://${HOST}:8554/replay/${token}</trp:Uri>`
    + '</trp:GetReplayUriResponse>');
}

const server = http.createServer((req, res) => {
  // Test introspection endpoint. Not part of ONVIF; it exists so the smoke
  // suite can assert that e.g. a Stop really reached the device.
  if (req.method === 'GET' && req.url.startsWith('/__calls')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const payload = PLAYBACK_MODE === 'off'
      ? callCounts
      : { ...callCounts, 'playback.openSearches': searchSessions.size };
    res.end(JSON.stringify(payload));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__reset')) {
    for (const k of Object.keys(callCounts)) delete callCounts[k];
    searchSessions.clear();
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

if (op === 'GetVideoEncoderConfigurationOptions') {
      const profileToken = (body.match(/<[^>]*ProfileToken[^>]*>([^<]*)</) ?? [])[1];
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(encoderOptionsXml(encoderTokenForProfile(profileToken)));
      return;
    }

    if (op === 'GetVideoEncoderConfigurations') {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(soapEnvelope('<trt:GetVideoEncoderConfigurationsResponse>'
        + Object.keys(encoderState).map(encoderConfigXml).join('')
        + '</trt:GetVideoEncoderConfigurationsResponse>'));
      return;
    }

    if (op === 'GetVideoEncoderConfiguration') {
      const token = (body.match(/<[^>]*ConfigurationToken[^>]*>([^<]*)</) ?? [])[1] ?? 'VideoEncoder';
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(soapEnvelope('<trt:GetVideoEncoderConfigurationResponse>'
        + encoderConfigXml(encoderState[token] ? token : 'VideoEncoder').replace(/trt:Configurations/g, 'trt:Configuration')
        + '</trt:GetVideoEncoderConfigurationResponse>'));
      return;
    }

    if (op === 'SetVideoEncoderConfiguration') {
      const token = (body.match(/token="([^"]+)"/) ?? [])[1] ?? 'VideoEncoder';
      const cfg = encoderState[token];
      if (cfg && ENCODER_MODE !== 'ignore') {
        const grab = (tag) => {
          const m = body.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}[^>]*>([^<]*)<`));
          return m ? Number(m[1]) : null;
        };
        const w = grab('Width'), h = grab('Height');
        const allowed = ENCODER_RESOLUTIONS[token] ?? [];
        // A real device rejects a resolution it never advertised.
        if (w !== null && h !== null && !allowed.some((r) => r.width === w && r.height === h)) {
          res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
          res.end(fault(`Resolution ${w}x${h} is not supported on ${token}`, 'ter:InvalidArgVal'));
          return;
        }
        if (w !== null) cfg.width = w;
        if (h !== null) cfg.height = h;
        const fps = grab('FrameRateLimit'); if (fps !== null) cfg.fps = fps;
        const br = grab('BitrateLimit'); if (br !== null) cfg.bitrate = br;
        const gov = grab('GovLength'); if (gov !== null) cfg.govLength = gov;
        const enc = (body.match(/<(?:[A-Za-z0-9_.-]+:)?Encoding[^>]*>([^<]*)</) ?? [])[1];
        if (enc) cfg.encoding = enc;
      }
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(soapEnvelope('<trt:SetVideoEncoderConfigurationResponse/>'));
      return;
    }

// --- Multi-channel emulation, only when MOCK_CHANNELS > 1 ---
    if (CHANNELS > 1) {
      if (op === 'GetVideoSources') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(multiVideoSourcesXml());
        return;
      }
      if (op === 'GetProfiles') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(multiProfilesXml());
        return;
      }
      if (op === 'GetImagingSettings' || op === 'SetImagingSettings') {
        const idx = channelIndexFor(body);
        // A recorder rejects an imaging request that names no channel rather
        // than quietly serving channel 1.
        if (idx === null || idx < 0 || idx >= CHANNELS) {
          res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
          res.end(fault('No such video source', 'ter:InvalidArgVal'));
          return;
        }
        const st = channelImaging[idx];
        if (op === 'SetImagingSettings') {
          callCounts[`imaging.set.ch${idx + 1}`] = (callCounts[`imaging.set.ch${idx + 1}`] ?? 0) + 1;
          for (const field of Object.keys(st)) {
            const v = valueIn(body, field);
            if (v !== null) st[field] = v;
          }
          res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
          res.end(soapEnvelope('<timg:SetImagingSettingsResponse xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl"/>'));
          return;
        }
        callCounts[`imaging.get.ch${idx + 1}`] = (callCounts[`imaging.get.ch${idx + 1}`] ?? 0) + 1;
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(soapEnvelope('<timg:GetImagingSettingsResponse xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl"><timg:ImagingSettings>'
          + Object.entries(st).map(([k, v]) => `<tt:${k} xmlns:tt="http://www.onvif.org/ver10/schema">${v}</tt:${k}>`).join('')
          + '</timg:ImagingSettings></timg:GetImagingSettingsResponse>'));
        return;
      }
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

    // --- Profile G emulation, only when MOCK_PLAYBACK_MODE != 'off' ---
    if (PLAYBACK_MODE !== 'off') {
      if (op === 'GetServices') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(getServicesWithPlayback());
        return;
      }

      // The probe is read-only; a mutating recording call is a probe bug, so
      // count the attempt on /__calls even though the call is rejected.
      if (service === 'recording' && /^(Create|Delete|Set)/.test(op)) {
        callCounts['playback.mutatingCalls'] = (callCounts['playback.mutatingCalls'] ?? 0) + 1;
        res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
        res.end(fault('Mutating recording operations are not supported by this mock', 'ter:ActionNotSupported'));
        return;
      }

      // replay-only advertises no search service; any search call is unsupported.
      if (service === 'search' && PLAYBACK_MODE === 'replay-only') {
        res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
        res.end(fault(`Operation ${op} is not supported`, 'ter:ActionNotSupported'));
        return;
      }

      if (PLAYBACK_CAPABILITIES[service] && op === 'GetServiceCapabilities') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(playbackSoap(PLAYBACK_CAPABILITIES[service]));
        return;
      }

      if (service === 'recording' && op === 'GetRecordings') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(getRecordingsXml());
        return;
      }

      if (service === 'recording' && op === 'GetRecordingSummary') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(getRecordingSummaryXml());
        return;
      }

      if (service === 'replay' && op === 'GetReplayUri') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(getReplayUriXml(body));
        return;
      }

      if (service === 'search' && (op === 'FindRecordings' || op === 'FindEvents')) {
        searchSeq += 1;
        const token = `SearchToken_${searchSeq}`;
        searchSessions.set(token, op);
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(playbackSoap(`<tse:${op}Response><tse:SearchToken>${token}</tse:SearchToken></tse:${op}Response>`));
        return;
      }

      if (service === 'search' && op === 'GetRecordingSearchResults') {
        if (PLAYBACK_MODE === 'broken-search') {
          res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
          res.end(fault('Search session failed on the recorder', 'ter:Action'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(recordingSearchResultsXml());
        return;
      }

      if (service === 'search' && op === 'GetEventSearchResults') {
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(eventSearchResultsXml());
        return;
      }

      if (service === 'search' && op === 'EndSearch') {
        const token = textIn(body, 'SearchToken');
        if (token) searchSessions.delete(token);
        res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        res.end(playbackSoap('<tse:EndSearchResponse/>'));
        return;
      }

      if (['recording', 'replay', 'search'].includes(service)) {
        console.log(`  [mock] ${service}.${op} -> not supported in playback mode ${PLAYBACK_MODE}`);
        res.writeHead(500, { 'Content-Type': 'application/soap+xml' });
        res.end(fault(`Operation ${op} is not supported by this mock`));
        return;
      }
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
  console.log(`  Encoder mode: ${ENCODER_MODE} (MOCK_ENCODER_MODE=ignore).`);
  console.log(`  Channels: ${CHANNELS} (MOCK_CHANNELS=16 to emulate a DVR).`);
  console.log(`  Network mode: ${NETWORK_MODE} (MOCK_NETWORK_MODE=ignore).`);
  console.log(`  Playback mode: ${PLAYBACK_MODE} (MOCK_PLAYBACK_MODE=full|replay-only|broken-search).`);
});
