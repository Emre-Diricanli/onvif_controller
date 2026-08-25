#!/usr/bin/env node
/**
 * Read-only ONVIF Profile G evidence probe.
 *
 * Connects through the same authenticated path as the app, then delegates all
 * recorder inspection to the playback probe. Output is sanitized before it
 * reaches either the terminal or disk.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectDevice } from '../server/onvif/connect.js';
import { probePlayback } from '../server/onvif/playback.js';
import { redactUri } from '../server/onvif/util.js';
import { config } from '../server/config.js';

const VERSION = '1';
let sensitiveSecrets = [process.env.ONVIF_PASS, process.env.ONVIF_USER].filter(Boolean);
const USAGE = `Usage: node tools/probe-playback.mjs --host <host> [options]

Read-only probe of an ONVIF recorder's Profile G playback support.

Options:
  --host <host>       Recorder hostname or IP address (required)
  --port <port>       ONVIF port (default: 80)
  --user <username>   ONVIF username (ONVIF_USER takes precedence)
  --pass <password>   ONVIF password (ONVIF_PASS takes precedence)
  --from <ISO 8601>   Search window start (default: 24 hours ago)
  --to <ISO 8601>     Search window end (default: now)
  --out <path>        Write a sanitized JSON evidence report
  --json              Print sanitized JSON instead of the human summary
  --timeout <ms>      Per-operation timeout in milliseconds
  --help              Show this help

Prefer ONVIF_USER and ONVIF_PASS so credentials do not enter shell history.`;

function fail(message) {
  const err = new Error(message);
  err.name = 'ArgumentError';
  throw err;
}

function parseArgs(argv) {
  const options = { port: 80, json: false, help: false };
  const values = new Set(['host', 'port', 'user', 'pass', 'from', 'to', 'out', 'timeout']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) fail(`Unknown argument: ${arg}`);

    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!values.has(name)) fail(`Unknown option: --${name}`);
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === '' || (equals === -1 && value.startsWith('--'))) {
      fail(`--${name} requires a value.`);
    }
    options[name] = value;
  }

  if (options.help) return options;
  if (!options.host) fail('--host is required.');

  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    fail('--port must be an integer between 1 and 65535.');
  }
  if (options.timeout !== undefined) {
    options.timeout = Number(options.timeout);
    if (!Number.isInteger(options.timeout) || options.timeout < 1) {
      fail('--timeout must be a positive integer in milliseconds.');
    }
  }

  const now = new Date();
  options.to = parseDate(options.to ?? now.toISOString(), '--to');
  options.from = parseDate(options.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), '--from');
  if (options.from >= options.to) fail('--from must be earlier than --to.');
  return options;
}

function parseDate(value, option) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/[tT]/.test(value)) {
    fail(`${option} must be an ISO 8601 date and time.`);
  }
  return date;
}

function isSensitiveKey(key) {
  return /pass(word)?|credential|authorization/i.test(key)
    || /(?:session|search).*token|token.*(?:session|search)/i.test(key)
    || /^(?:user|username)$/i.test(key);
}

function redactText(value, secrets) {
  let safe = value;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(safe)) return redactUri(safe) ?? '[REDACTED URI]';
  return safe.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (uri) => redactUri(uri) ?? '[REDACTED URI]');
}

function sanitize(value, secrets, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, seen));
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [String(key), sanitize(item, secrets, seen)]));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitize(item, secrets, seen);
  }
  return output;
}

function stepEntries(report) {
  const steps = report?.steps ?? report?.probeSteps ?? [];
  if (Array.isArray(steps)) return steps.map((step, index) => [step?.name ?? step?.step ?? `Step ${index + 1}`, step]);
  if (steps && typeof steps === 'object') return Object.entries(steps);
  return [];
}

function statusOf(step) {
  const raw = String(step?.status ?? step?.result ?? '').toLowerCase();
  if (raw.includes('not') || raw === 'unsupported' || step?.supported === false) return 'NOT SUPPORTED';
  if (raw.includes('fail') || raw.includes('error') || step?.error) return 'FAILED';
  if (raw.includes('support') || raw.includes('success') || raw === 'ok' || step?.supported === true) return 'SUPPORTED';
  return raw ? raw.toUpperCase() : 'OBSERVED';
}

function faultOf(step) {
  const error = step?.error ?? step?.fault;
  if (typeof error === 'string') return error;
  return error?.faultText ?? error?.reason ?? error?.message ?? step?.faultText ?? step?.message ?? null;
}

function summarizeDetail(step) {
  for (const key of ['summary', 'detail', 'count', 'observed']) {
    const value = step?.[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function printHuman(report, host, from, to) {
  console.log(`\nPlayback probe: ${host}`);
  console.log(`Window: ${from.toISOString()} to ${to.toISOString()}`);
  const entries = stepEntries(report);
  if (!entries.length) {
    console.log('\nProbe completed. See --json or --out for the recorded evidence.');
    return;
  }
  // The service table answers "is Profile G here at all", which is the first
  // thing an operator wants and is not visible from the step list alone.
  if (report.services) {
    console.log('\nServices');
    for (const [name, svc] of Object.entries(report.services)) {
      const origin = svc?.origin === 'guessed' ? ' (URL guessed, not advertised)' : '';
      console.log(`  ${name.padEnd(10)} ${svc?.present ? 'present' : 'not advertised'}${origin}`);
    }
  }

  for (const [name, step] of entries) {
    console.log(`\n${name} — ${statusOf(step)}`);
    const detail = summarizeDetail(step);
    const fault = faultOf(step);
    if (detail) console.log(`  ${detail}`);
    if (fault && fault !== detail) console.log(`  Device response: ${fault}`);
  }

  // Channel mapping decides whether a player can trust the channel the operator
  // picked, so it is called out rather than left buried in the JSON.
  if (report.channelMapping) {
    console.log('\nChannel mapping');
    console.log(report.channelMapping.derivable
      ? '  Recording sources map onto media profiles by exact identifier.'
      : '  NOT derivable — recording source identifiers do not match media profile video source tokens.');
  }

  // The conclusion is the answer to the question the probe was run to settle.
  if (report.conclusion) console.log(`\nConclusion\n  ${report.conclusion}`);
  console.log('');
}

function safeError(err, secrets) {
  return {
    code: err?.code ?? err?.name ?? 'ERROR',
    message: redactText(String(err?.message ?? err), secrets),
    hint: err?.hint ? redactText(String(err.hint), secrets) : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }

  const username = process.env.ONVIF_USER ?? options.user ?? '';
  const password = process.env.ONVIF_PASS ?? options.pass ?? '';
  const secrets = [password, username].filter(Boolean);
  sensitiveSecrets = secrets;
  if (options.timeout) config.onvifTimeoutMs = options.timeout;

  const session = await connectDevice({
    host: options.host,
    port: options.port,
    username,
    password,
  });
  let report;
  try {
    report = await probePlayback(session, {
      from: options.from,
      to: options.to,
      onStep: null,
    });
  } finally {
    // connectDevice opens an onvif camera outside the session registry, so
    // nothing else will tear it down. Without this the probe can hold the
    // socket open and hang instead of exiting after printing its report.
    try { session.cam?.removeAllListeners?.(); } catch { /* nothing to clean up */ }
  }
  const evidence = sanitize({
    ...report,
    meta: {
      probeVersion: VERSION,
      timestamp: new Date().toISOString(),
      host: options.host,
    },
  }, secrets);

  if (options.out) {
    await writeFile(resolve(options.out), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (options.json) console.log(JSON.stringify(evidence, null, 2));
  else printHuman(evidence, options.host, options.from, options.to);
}

try {
  await main();
} catch (err) {
  const argvPasswordIndex = process.argv.indexOf('--pass');
  if (argvPasswordIndex !== -1 && process.argv[argvPasswordIndex + 1]) {
    sensitiveSecrets.push(process.argv[argvPasswordIndex + 1]);
  }
  const argvPassword = process.argv.find((arg) => arg.startsWith('--pass='));
  if (argvPassword) sensitiveSecrets.push(argvPassword.slice('--pass='.length));
  const safe = safeError(err, sensitiveSecrets);
  console.error(`Playback probe failed: ${safe.message}`);
  if (safe.hint) console.error(safe.hint);
  if (err?.name === 'ArgumentError') console.error('Run with --help for usage.');
  process.exitCode = 1;
}
