#!/usr/bin/env node
// Standalone Profile G reachability probe with robust auth.
//
// Unlike tools/probe-playback.mjs (which connects through the app's `onvif`
// library), this speaks WS-Security UsernameToken digest by hand, so it works
// on devices where the library mishandles an empty or simple password — a real
// case observed on UNIX RST08 / IPM32R32P recorders. Read-only: it issues only
// Get*/Find* calls, never a Create*/Delete*/Set*.
//
//   node tools/probe-recorder.mjs --host 10.0.0.5 --port 80 --user admin --pass secret
//
// Credentials come from argv or ONVIF_USER/ONVIF_PASS; nothing is written to disk.

import crypto from 'node:crypto';
import http from 'node:http';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, arr) => {
  if (t.startsWith('--')) a.push([t.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));

if (args.help || !args.host) {
  console.log(`Usage: node tools/probe-recorder.mjs --host <ip> [--port 80] [--user admin] [--pass ...]
Reports whether a recorder exposes ONVIF Profile G (Recording/Replay/Search).
Reads ONVIF_USER / ONVIF_PASS from the environment if --user/--pass are omitted.`);
  process.exit(0);
}

const HOST = args.host;
const PORT = Number(args.port || 80);
const USER = process.env.ONVIF_USER ?? (typeof args.user === 'string' ? args.user : 'admin');
const PASS = process.env.ONVIF_PASS ?? (typeof args.pass === 'string' ? args.pass : '');
const TIMEOUT = Number(args.timeout || 12000);

function wsse() {
  const created = new Date().toISOString();
  const nonce = crypto.randomBytes(16);
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(PASS)])).digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${USER}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`;
}

function soap(path, inner, { auth = true } = {}) {
  return new Promise((res) => {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${auth ? wsse() : ''}<s:Body>${inner}</s:Body></s:Envelope>`;
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, timeout: TIMEOUT },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, xml: d })); });
    req.on('error', (e) => res({ code: 0, xml: 'ERR ' + e.code }));
    req.on('timeout', () => { req.destroy(); res({ code: 0, xml: 'TIMEOUT' }); });
    req.end(body);
  });
}
const val = (xml, tag) => (xml.match(new RegExp(`${tag}>([^<]*)`)) || [])[1] || null;

const DEV = '/onvif/device_service';
console.log(`\nProbing ${HOST}:${PORT} as ${USER || '(empty)'} …\n`);

// 1. Auth
const info = await soap(DEV, '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>');
if (info.code !== 200) {
  console.log(`Auth FAILED (HTTP ${info.code}). ${(info.xml.match(/Text[^>]*>([^<]+)/) || [])[1] || ''}`);
  console.log('The credentials or auth scheme were rejected — cannot probe further.');
  process.exit(1);
}
console.log(`Device: ${val(info.xml,'Manufacturer')} ${val(info.xml,'Model')} — firmware ${val(info.xml,'FirmwareVersion')}`);

// 2. Authoritative service list
const svc = await soap(DEV, '<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>false</IncludeCapability></GetServices>');
const ns = [...svc.xml.matchAll(/Namespace>([^<]+)/g)].map((m) => m[1]);
const has = (re) => ns.some((n) => re.test(n));
const profileG = { recording: has(/ver10\/recording/), replay: has(/ver10\/replay/), search: has(/ver10\/search/) };

console.log('\nProfile G services (from GetServices — authoritative):');
for (const [k, v] of Object.entries(profileG)) console.log(`  ${k.padEnd(10)} ${v ? 'ADVERTISED ✓' : 'absent'}`);

if (!profileG.recording && !profileG.replay && !profileG.search) {
  console.log('\nConclusion: no Profile G. This recorder does not expose recorded video over ONVIF.');
  process.exit(0);
}

// 3. Real round-trips against what it claims
const xaddr = (re) => { for (const b of svc.xml.matchAll(/<[^>]*Service>[\s\S]*?<\/[^>]*Service>/g)) if (re.test(b[0])) return (b[0].match(/XAddr>([^<]+)/) || [])[1]; return null; };
const path = (u) => { try { return new URL(u).pathname; } catch { return u; } };

if (profileG.recording) {
  const rec = await soap(path(xaddr(/ver10\/recording/) || DEV), '<GetRecordingSummary xmlns="http://www.onvif.org/ver10/search/wsdl"/>');
  const from = val(rec.xml, 'DataFrom'), until = val(rec.xml, 'DataUntil'), n = val(rec.xml, 'NumberRecordings');
  console.log(`\nRecording summary: ${rec.code === 200 ? `${n} recording(s), spanning ${from} … ${until}` : `HTTP ${rec.code}`}`);
}
console.log('\nConclusion: Profile G is present. Run the full playback probe next to test search + replay + seek.');
process.exit(0);
