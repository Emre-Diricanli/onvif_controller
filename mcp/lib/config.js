/** Configuration is validated before any controller or camera is contacted. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockList, isIP } from 'node:net';

const DEFAULT_FILE = fileURLToPath(new URL('../config.json', import.meta.url));
const validated = new WeakSet();
const warnings = new WeakMap();
const fail = (field, message) => { throw new Error(`Invalid MCP config field ${field}: ${message}.`); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v, field, empty = false) => {
  if (typeof v !== 'string' || (!empty && !v.trim())) fail(field, 'expected a string');
};

function resolveEnv(value, field = 'config') {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const name = value.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || process.env[name] === undefined) {
      fail(field, 'environment reference is invalid or unset');
    }
    return process.env[name];
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnv(v, `${field}[${i}]`));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, `${field}.${k}`)]));
  return value;
}

export function normalizeHost(host) {
  return String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function validHost(host) {
  if (typeof host !== 'string' || host !== host.trim()) return false;
  const value = normalizeHost(host);
  return Boolean(isIP(value)) || (value.length <= 253 && value.split('.').every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s)));
}

export function isLoopback(host) {
  const value = normalizeHost(host);
  return value === 'localhost' || value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

function subnet(rule) {
  const [address, prefix, extra] = rule.split('/');
  const family = isIP(address);
  if (extra !== undefined || !family || !/^\d+$/.test(prefix ?? '') || Number(prefix) > (family === 4 ? 32 : 128)) return null;
  const block = new BlockList();
  block.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  return block;
}

/** Resolve names on the controller, not this machine: CIDRs match literal IPs only. */
export function hostAllowed(host, allowHosts) {
  if (!validHost(host)) return false;
  if (allowHosts === undefined) return true;
  const normalized = normalizeHost(host);
  return allowHosts.some((rule) => {
    if (!rule.includes('/')) return normalizeHost(rule) === normalized;
    const family = isIP(normalized);
    return Boolean(family && subnet(rule)?.check(normalized, family === 4 ? 'ipv4' : 'ipv6'));
  });
}

export function validateConfig(input, { resolveEnvironment = true } = {}) {
  if (object(input) && validated.has(input)) return input;
  if (!object(input)) fail('config', 'expected an object');
  const config = resolveEnvironment ? resolveEnv(input) : structuredClone(input);
  if (!Array.isArray(config.controllers) || !config.controllers.length) fail('controllers', 'expected a nonempty array');
  if (config.devices !== undefined && !Array.isArray(config.devices)) fail('devices', 'expected an array');
  config.devices ??= [];
  const names = new Set();
  const notices = [];
  config.controllers.forEach((c, i) => {
    const field = `controllers[${i}]`;
    if (!object(c)) fail(field, 'expected an object');
    string(c.name, `${field}.name`);
    if (names.has(c.name)) fail(`${field}.name`, 'duplicate controller name');
    names.add(c.name);
    string(c.url, `${field}.url`);
    let url;
    try { url = new URL(c.url); } catch { fail(`${field}.url`, 'expected an HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      fail(`${field}.url`, 'use HTTP or HTTPS without credentials, query or fragment');
    }
    if (c.token != null) {
      string(c.token, `${field}.token`, true);
      if (/[\r\n]/.test(c.token)) fail(`${field}.token`, 'must not contain newlines');
    }
    if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0 || c.timeoutMs > 2 ** 31 - 1)) {
      fail(`${field}.timeoutMs`, 'expected a positive integer at most 2147483647');
    }
    if (c.allowHosts !== undefined) {
      if (!Array.isArray(c.allowHosts)) fail(`${field}.allowHosts`, 'expected an array of hosts or CIDRs');
      c.allowHosts.forEach((rule, j) => {
        if (typeof rule !== 'string' || !(rule.includes('/') ? subnet(rule) : validHost(rule))) {
          fail(`${field}.allowHosts[${j}]`, 'expected a host or IPv4/IPv6 CIDR');
        }
      });
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !c.token) {
      notices.push(`${field} uses remote HTTP without a controller token. Use an SSH tunnel or a token with HTTPS via a reverse proxy.`);
    }
  });
  config.defaultController ??= config.controllers[0].name;
  if (!names.has(config.defaultController)) fail('defaultController', 'must name a configured controller');
  const devices = new Set();
  config.devices.forEach((d, i) => {
    const field = `devices[${i}]`;
    if (!object(d)) fail(field, 'expected an object');
    string(d.name, `${field}.name`);
    if (devices.has(d.name)) fail(`${field}.name`, 'duplicate device name');
    devices.add(d.name);
    d.controller ??= config.defaultController;
    if (!names.has(d.controller)) fail(`${field}.controller`, 'must name a configured controller');
    if (!validHost(d.host)) fail(`${field}.host`, 'expected a hostname or IP address without credentials or a URL');
    if (d.port !== undefined && (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)) fail(`${field}.port`, 'expected an integer from 1 to 65535');
    for (const key of ['username', 'password', 'label', 'notes', 'protocol']) {
      if (d[key] != null) string(d[key], `${field}.${key}`, key !== 'protocol');
    }
  });
  validated.add(config);
  warnings.set(config, notices);
  return config;
}

export function configWarnings(config) {
  return warnings.get(config) ?? [];
}

export function loadConfig(file = process.env.ONVIF_MCP_CONFIG ?? DEFAULT_FILE) {
  let source;
  try { source = readFileSync(path.resolve(file), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') fail('file', 'could not read the configuration');
    return validateConfig({
      controllers: [{ name: 'local', url: process.env.ONVIF_CONTROLLER_URL ?? 'http://127.0.0.1:8080' }],
      devices: [], defaultController: 'local',
    });
  }
  let raw;
  try { raw = JSON.parse(source); } catch { fail('file', 'expected valid JSON'); }
  const config = validateConfig(raw);
  raw.devices?.forEach((d, i) => {
    if (typeof d.password === 'string' && d.password && !d.password.startsWith('env:')) {
      warnings.get(config).push(`devices[${i}].password is plaintext in the config file. Use an env: reference for credentials.`);
    }
  });
  return config;
}
