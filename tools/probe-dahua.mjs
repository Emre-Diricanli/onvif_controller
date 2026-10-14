#!/usr/bin/env node
// Dahua / Lorex HTTP API (CGI) probe — runs the Dahua adapter against a real
// device and prints what it sees, so a persona can be checked against firmware.
//
//   node tools/probe-dahua.mjs --host 192.168.0.108 [--port 80] [--user admin] [--pass ...]
//
// Read-only: probe, connect, listTargets, describeSettings and read only. It
// never calls write. Credentials come from argv or ONVIF_USER/ONVIF_PASS;
// nothing is written to disk and the password is never printed. All traffic
// goes through the adapter, hence through the governed transport.

import * as adapter from '../server/adapters/dahua/index.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, arr) => {
  if (t.startsWith('--')) a.push([t.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
if (args.help || typeof args.host !== 'string') {
  console.log('Usage: node tools/probe-dahua.mjs --host <ip> [--port 80] [--user admin] [--pass ...] [--timeout 8000]');
  process.exit(0);
}
const config = {
  host: args.host,
  port: Number(args.port || 80),
  username: process.env.ONVIF_USER ?? (typeof args.user === 'string' ? args.user : 'admin'),
  password: process.env.ONVIF_PASS ?? (typeof args.pass === 'string' ? args.pass : ''),
  timeoutMs: Number(args.timeout || 8000),
};

console.log(`\nDahua CGI probe ${config.host}:${config.port} as ${config.username} …\n`);

const probed = await adapter.probe(config);
console.log(`probe: ${probed.match ? 'MATCH' : 'no match'} (confidence ${probed.confidence})`
  + `${probed.model ? ` model=${probed.model}` : ''}${probed.firmware ? ` firmware=${probed.firmware}` : ''}`);
if (!probed.match) {
  console.log('The device did not answer magicBox.cgi?action=getDeviceType with a "type=" line (or rejected the credentials).');
}

let conn;
try {
  conn = await adapter.connect(config);
} catch (err) {
  // AppError messages never carry credentials (ADAPTERS.md §7).
  console.log(`connect failed: ${err?.code ?? 'ERROR'} ${err?.message ?? ''}`);
  process.exit(1);
}

try {
  const { vendor, model, firmware, serial } = conn.info;
  console.log(`device: ${vendor} ${model} — firmware ${firmware ?? '?'} — serial ${serial ?? '?'}\n`);
  const targets = await conn.listTargets();
  console.log(`${targets.length} targets`);
  for (const target of targets) {
    console.log(`\n[${target.id}] ${target.scope} "${target.label}"${target.parent ? ` (parent ${target.parent})` : ''}`);
    try {
      const descriptors = await conn.describeSettings(target.id);
      const { values } = await conn.read(target.id);
      for (const d of descriptors) {
        const range = d.min !== undefined ? ` [${d.min}..${d.max}]` : d.values ? ` {${d.values.join('|')}}` : '';
        const unit = d.unit ? ` ${d.unit}` : '';
        console.log(`  ${d.key.padEnd(20)} = ${JSON.stringify(values[d.key])}${unit}   (${d.type}${range}, ${d.resource})`);
      }
      if (descriptors.length === 0) console.log('  (no settings described)');
    } catch (err) {
      console.log(`  read failed: ${err?.code ?? 'ERROR'} ${err?.message ?? ''}`);
    }
  }
} finally {
  conn.close();
}
