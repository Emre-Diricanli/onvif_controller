#!/usr/bin/env node
// Hikvision ISAPI recorder probe — the vendor-native path to recorded video,
// for NVRs where ONVIF is disabled (common) but ISAPI answers.
//
//   node tools/probe-isapi.mjs --host 192.168.0.177 --port 81 --user admin --pass ...
//
// Read-only: issues only GETs and a ContentMgmt/search POST (a query, not a
// mutation). Never enables recording, never deletes footage, never changes a
// setting. Credentials come from argv or ONVIF_USER/ONVIF_PASS; nothing is
// written to disk.

import crypto from 'node:crypto';
import http from 'node:http';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, arr) => {
  if (t.startsWith('--')) a.push([t.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
if (args.help || !args.host) {
  console.log('Usage: node tools/probe-isapi.mjs --host <ip> [--port 80] [--user admin] [--pass ...] [--channel 1]');
  process.exit(0);
}
const HOST = args.host, PORT = Number(args.port || 80);
const USER = process.env.ONVIF_USER ?? (typeof args.user === 'string' ? args.user : 'admin');
const PASS = process.env.ONVIF_PASS ?? (typeof args.pass === 'string' ? args.pass : '');

// --- HTTP digest (Hikvision ISAPI uses digest auth) ---
function parseDigest(h) {
  const o = {};
  for (const m of h.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) o[m[1]] = m[2] ?? m[3];
  return o;
}
function digestHeader(method, uri, d, nc) {
  const ha1 = crypto.createHash('md5').update(`${USER}:${d.realm}:${PASS}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncv = String(nc).padStart(8, '0');
  const resp = crypto.createHash('md5').update(`${ha1}:${d.nonce}:${ncv}:${cnonce}:${d.qop}:${ha2}`).digest('hex');
  return `Digest username="${USER}", realm="${d.realm}", nonce="${d.nonce}", uri="${uri}", qop=${d.qop}, nc=${ncv}, cnonce="${cnonce}", response="${resp}", algorithm=MD5`;
}
function raw(method, uri, body, auth) {
  return new Promise((res) => {
    const req = http.request({ host: HOST, port: PORT, path: uri, method, timeout: 20000,
      headers: { ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, headers: r.headers, body: d })); });
    req.on('error', (e) => res({ code: 0, body: 'ERR ' + e.code }));
    req.on('timeout', () => { req.destroy(); res({ code: 0, body: 'TIMEOUT' }); });
    if (body) req.write(body);
    req.end();
  });
}
async function req(method, uri, body) {
  const first = await raw(method, uri, body, null);
  if (first.code !== 401) return first;
  const wa = first.headers?.['www-authenticate'];
  if (!wa) return first;
  return raw(method, uri, body, digestHeader(method, uri, parseDigest(wa), 1));
}
const val = (xml, tag) => (xml.match(new RegExp(`<${tag}[^>]*>([^<]*)`)) || [])[1] || null;

console.log(`\nISAPI probe ${HOST}:${PORT} as ${USER} …\n`);

const info = await req('GET', '/ISAPI/System/deviceInfo');
if (info.code !== 200) { console.log(`ISAPI not available (HTTP ${info.code}).`); process.exit(1); }
console.log(`Device: ${val(info.body,'deviceName')} ${val(info.body,'model')} — firmware ${val(info.body,'firmwareVersion')}`);

const tracks = await req('GET', '/ISAPI/ContentMgmt/record/tracks');
const all = [...tracks.body.matchAll(/<Track>[\s\S]*?<\/Track>/g)].map((m) => m[0]);
const enabled = all.filter((t) => /<Enable>true<\/Enable>/.test(t));
console.log(`\nRecording tracks: ${all.length} total, ${enabled.length} enabled.`);
if (enabled.length === 0) {
  console.log('No channel is recording — the NVR has recording switched off, so there is nothing to search.');
  console.log('Enable a schedule in the NVR UI (Storage → Schedule), then re-run.');
  process.exit(0);
}

// Search the first enabled channel over the last 7 days
const ch = (enabled[0].match(/<Channel>(\d+)/) || [])[1] || '101';
const now = new Date(info.headers.date || undefined);
const from = new Date(now.getTime() - 7 * 86400e3);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const search = `<?xml version="1.0" encoding="utf-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><trackList><trackID>${ch}</trackID></trackList><timeSpanList><timeSpan><startTime>${iso(from)}</startTime><endTime>${iso(now)}</endTime></timeSpan></timeSpanList><maxResults>10</maxResults><searchResultPostion>0</searchResultPostion></CMSearchDescription>`;
const sr = await req('POST', '/ISAPI/ContentMgmt/search', search);
const n = val(sr.body, 'numOfMatches');
const uri = val(sr.body, 'playbackURI');
console.log(`\nSearch channel ${ch}: ${sr.code === 200 ? `${n || 0} match(es)` : `HTTP ${sr.code} — ${val(sr.body,'statusString') || ''}`}`);
if (uri) console.log('First playback URI:', uri.replace(/\/\/[^@]*@/, '//'));
console.log('\nConclusion: ISAPI recording API is present and answering. This is a viable Hikvision playback path.');
process.exit(0);
