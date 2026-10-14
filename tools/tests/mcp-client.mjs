/** Client boundaries, validated configuration, session races, and authenticated MCP. */
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, createChecker, freePort } from '../../mcp/test/harness.mjs';
import { ControllerClient, ControllerError, MAX_JSON_BYTES, MAX_IMAGE_BYTES } from '../../mcp/lib/client.js';
import { createContext, loadConfig } from '../../mcp/lib/context.js';
import { hostAllowed } from '../../mcp/lib/config.js';

const t = createChecker('MCP controller client and sessions');
const quiet = { log() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function rejects(name, fn, expected) {
  try { await fn(); t.check(name, false, 'did not reject'); } catch (err) {
    t.check(name, typeof expected === 'string' ? err.code === expected : expected.test(err.message), `${err.code ?? ''}: ${err.message}`);
    return err;
  }
}
const config = (url, extra = {}) => ({ controllers: [{ name: 'local', url, ...extra }], devices: [
  { name: 'mock-cam', host: '127.0.0.1', username: 'admin', password: 'camera-secret' },
] });
let connects = 0;
let disconnects = 0;
let writes = 0;
let mode = 'normal';
const fake = http.createServer(async (req, res) => {
  req.resume();
  if (req.url === '/slow') { await delay(100); if (!res.destroyed) res.end('{}'); return; }
  if (req.url === '/slow-body') { res.writeHead(200); res.write('{'); await delay(100); if (!res.destroyed) res.end('}'); return; }
  if (req.url === '/unauthorized') { res.writeHead(401); res.end('controller-secret'); return; }
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/api/connect' }); res.end('{}'); return; }
  if (req.url === '/malformed') { res.end('{broken'); return; }
  if (req.url === '/secret-error') {
    res.writeHead(502); res.end(JSON.stringify({ error: { code: 'DEVICE_ERROR', message: 'camera-secret controller-secret', hint: 'rtsp://u:camera-secret@camera/x' } })); return;
  }
  if (req.url === '/safe-json') { res.end(JSON.stringify({ password: 'hidden', stream: 'rtsp://u:pass@camera/x', token: 'Profile_1' })); return; }
  if (req.url === '/oversize-header') { res.writeHead(200, { 'Content-Length': MAX_JSON_BYTES + 1 }); res.end(); return; }
  if (req.url === '/oversize-json' || req.url === '/oversize-image' || req.url === '/oversize-error') {
    res.writeHead(req.url === '/oversize-error' ? 500 : 200, { 'Transfer-Encoding': 'chunked' });
    const length = req.url === '/oversize-image' ? MAX_IMAGE_BYTES : MAX_JSON_BYTES;
    res.end(Buffer.alloc(length + 1, 32)); return;
  }
  if (req.url === '/api/connect') {
    connects += 1;
    const id = `session-${connects}`;
    await delay(30);
    if (mode === 'connect-fail') { res.writeHead(502); res.end('{"error":{"code":"DEVICE_ERROR"}}'); return; }
    res.end(JSON.stringify({ sessionId: id, protocol: 'onvif', device: { model: 'fake' } })); return;
  }
  if (req.url.endsWith('/disconnect')) { disconnects += 1; res.writeHead(204); res.end(); return; }
  if (req.method === 'PATCH') {
    writes += 1;
    res.writeHead(504); res.end('{"error":{"code":"DEVICE_TIMEOUT"}}'); return;
  }
  res.end('{}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fake.address().port}`;
const awaitPort = await freePort();
try {
  t.section('HTTP client');
  t.check('direct client accepts literal env-prefixed tokens', new ControllerClient({ name: 'literal', url, token: 'env:literal-secret' }).token === 'env:literal-secret');
  const client = new ControllerClient({ name: 'local', url, token: 'controller-secret', timeoutMs: 1000 });
  const unauthorized = await rejects('401 is controller auth error', () => client.request('GET', '/unauthorized'), 'CONTROLLER_UNAUTHORIZED');
  t.check('401 includes token remediation without token value', unauthorized.status === 401 && /token/i.test(unauthorized.hint) && !JSON.stringify(unauthorized).includes('controller-secret'));
  await rejects('unreachable mapped', () => new ControllerClient({ name: 'closed', url: `http://127.0.0.1:${awaitPort}` }).health(), 'CONTROLLER_UNREACHABLE');
  await rejects('header timeout mapped', () => client.request('GET', '/slow', undefined, { timeoutMs: 10 }), 'CONTROLLER_TIMEOUT');
  await rejects('body timeout mapped', () => client.request('GET', '/slow-body', undefined, { timeoutMs: 10 }), 'CONTROLLER_TIMEOUT');
  await rejects('Content-Length cap enforced', () => client.request('GET', '/oversize-header'), 'CONTROLLER_RESPONSE_TOO_LARGE');
  await rejects('streamed JSON cap enforced', () => client.request('GET', '/oversize-json'), 'CONTROLLER_RESPONSE_TOO_LARGE');
  await rejects('streamed image cap enforced', () => client.request('GET', '/oversize-image', undefined, { binary: true }), 'CONTROLLER_RESPONSE_TOO_LARGE');
  await rejects('error response cap enforced', () => client.request('GET', '/oversize-error'), 'CONTROLLER_RESPONSE_TOO_LARGE');
  await rejects('invalid JSON mapped', () => client.request('GET', '/malformed'), 'CONTROLLER_INVALID_RESPONSE');
  const beforeRedirect = connects;
  await rejects('redirect is not followed', () => client.request('GET', '/redirect'), 'HTTP_302');
  t.check('redirect does not create a session', connects === beforeRedirect);
  const secret = await rejects('upstream error code retained', () => client.request('POST', '/secret-error', { password: 'camera-secret' }), 'DEVICE_ERROR');
  t.check('upstream error secrets removed', !/camera-secret|controller-secret/.test(`${secret.message} ${secret.hint}`));
  const safe = await client.request('GET', '/safe-json');
  t.check('credentials removed without breaking profile tokens', safe.password === '***' && safe.stream === 'rtsp://***@camera/x' && safe.token === 'Profile_1');

  t.section('configuration');
  for (const [name, mutate, field] of [
    ['duplicate controllers', (c) => c.controllers.push(c.controllers[0]), /controllers\[1\].name/],
    ['duplicate devices', (c) => c.devices.push(c.devices[0]), /devices\[1\].name/],
    ['URL scheme', (c) => { c.controllers[0].url = 'ftp://camera'; }, /controllers\[0\].url/],
    ['credentialed URL', (c) => { c.controllers[0].url = 'http://u:private@camera'; }, /controllers\[0\].url/],
    ['unknown default', (c) => { c.defaultController = 'missing'; }, /defaultController/],
    ['unknown controller', (c) => { c.devices[0].controller = 'missing'; }, /devices\[0\].controller/],
    ['bad port', (c) => { c.devices[0].port = 0; }, /devices\[0\].port/],
    ['credentialed host', (c) => { c.devices[0].host = 'http://u:private@camera'; }, /devices\[0\].host/],
    ['invalid CIDR', (c) => { c.controllers[0].allowHosts = ['10.0.0.0/33']; }, /allowHosts\[0\]/],
    ['invalid timeout', (c) => { c.controllers[0].timeoutMs = -1; }, /timeoutMs/],
  ]) {
    const c = config(url); mutate(c);
    const err = await rejects(name, () => createContext(c, quiet), field);
    t.check(`${name} error omits values`, !err.message.includes('private'));
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'));
  const file = path.join(dir, 'config.json');
  const previous = { ...process.env };
  try {
    process.env.MCP_TEST_URL = url;
    process.env.MCP_TEST_PASSWORD = 'env:literal-password';
    process.env.MCP_TEST_TOKEN = 'controller-secret';
    process.env.MCP_TEST_HOST = '127.0.0.1';
    const raw = config('env:MCP_TEST_URL', { token: 'env:MCP_TEST_TOKEN' });
    raw.devices[0].password = 'env:MCP_TEST_PASSWORD';
    raw.devices[0].host = 'env:MCP_TEST_HOST';
    writeFileSync(file, JSON.stringify(raw));
    process.env.ONVIF_MCP_CONFIG = file;
    const loaded = loadConfig();
    t.check('env refs resolve in every string field', loaded.controllers[0].url === url && loaded.devices[0].host === '127.0.0.1' && loaded.devices[0].password === 'env:literal-password');
    const logs = [];
    const ctx = createContext(loaded, { log: (level, msg) => logs.push(`${level} ${msg}`) });
    t.check('resolved env values are not interpreted twice', ctx.controllers.get('local').token === 'controller-secret');
    t.check('env passwords do not trigger plaintext warning', logs.length === 0);
    await ctx.close();
    delete process.env.MCP_TEST_PASSWORD;
    await rejects('missing env names bad field', () => loadConfig(file), /devices\[0\].password/);
    raw.devices[0].password = 'plain-secret'; raw.controllers[0].url = 'http://remote.example'; delete raw.controllers[0].token;
    writeFileSync(file, JSON.stringify(raw));
    const warned = createContext(loadConfig(file), { log: (level, msg) => logs.push(`${level} ${msg}`) });
    t.check('file password and remote unauthenticated HTTP warn', logs.length === 2 && logs.every((s) => !s.includes('plain-secret')));
    await warned.close();
    writeFileSync(file, '{secret malformed');
    await rejects('invalid JSON reports file without content', () => loadConfig(file), /field file: expected valid JSON/);
    process.env.ONVIF_CONTROLLER_URL = url;
    t.check('missing file falls back to local controller', loadConfig(path.join(dir, 'missing')).controllers[0].url === url);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }

  t.section('session lifecycle');
  const ctx = createContext(config(url), quiet);
  let baseConnects = connects;
  const ids = await Promise.all(Array.from({ length: 12 }, () => ctx.sessions.use('mock-cam', (_c, id) => id)));
  t.check('concurrent first use shares one connect', connects === baseConnects + 1 && new Set(ids).size === 1);
  t.check('configured sessions declare adhoc false and omit credentials', ctx.sessions.list()[0].adhoc === false && !JSON.stringify([...ctx.devices.values()]).includes('camera-secret') && !JSON.stringify(ctx.sessions.list()).includes('camera-secret'));
  baseConnects = connects;
  const expiredId = ids[0];
  const recovered = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.sessions.use('mock-cam', async (_c, id) => {
    if (id === expiredId) { await delay(i * 15); throw new ControllerError('SESSION_EXPIRED', 'Expired.'); }
    return id;
  })));
  t.check('concurrent expiry reconnects exactly once including late failures', connects === baseConnects + 1 && new Set(recovered).size === 1);
  const beforeWrites = writes;
  await rejects('device timeout is never replayed', () => ctx.sessions.use('mock-cam', (c, id) => c.writeSettings(id, 'source:1', {})), 'DEVICE_TIMEOUT');
  t.check('only one write attempted', writes === beforeWrites + 1);
  const adhoc = await ctx.sessions.connect({ host: '127.0.0.2', username: 'a', password: 'b' });
  t.check('ad-hoc flag true', ctx.sessions.list().find((s) => s.ref === adhoc.ref)?.adhoc === true);
  await ctx.sessions.disconnect(adhoc.ref);
  t.check('disconnect forgets ad-hoc handle', !ctx.devices.has(adhoc.ref));
  const beforeClose = disconnects;
  await Promise.all([ctx.close(), ctx.close()]);
  t.check('close disconnects live sessions once', disconnects === beforeClose + 1);
  await rejects('closed context refuses new use', () => ctx.sessions.use('mock-cam', () => {}), 'CONTEXT_CLOSED');
  const pendingCtx = createContext(config(url), quiet);
  const pendingUse = pendingCtx.sessions.use('mock-cam', (_c, id) => id);
  const beforePendingClose = disconnects;
  await Promise.all([pendingUse, pendingCtx.close()]);
  t.check('close waits for pending connect and disconnects it', disconnects === beforePendingClose + 1 && !pendingCtx.sessions.list()[0].connected);
  const failureCtx = createContext(config(url), quiet);
  mode = 'connect-fail';
  await rejects('failed connect surfaces error', () => failureCtx.sessions.use('mock-cam', () => {}), 'DEVICE_ERROR');
  mode = 'normal';
  t.check('failed connect does not poison pending cache', Boolean(await failureCtx.sessions.use('mock-cam', (_c, id) => id)));
  await failureCtx.close();

  t.section('ad-hoc allowlists');
  const allow = ['10.2.0.0/16', 'camera.example', '2001:db8::/32'];
  t.check('IPv4 CIDRs and exact hostnames work', hostAllowed('10.2.3.4', allow) && hostAllowed('CAMERA.example.', allow) && !hostAllowed('10.3.0.1', allow));
  t.check('IPv6 CIDRs work', hostAllowed('[2001:db8::1]', allow) && !hostAllowed('2001:db9::1', allow));
  t.check('CIDRs never authorize a DNS name or URL', !hostAllowed('localhost', ['127.0.0.0/8']) && !hostAllowed('http://10.2.3.4', allow));
  const limited = createContext(config(url, { allowHosts: allow }), quiet);
  const beforeDenied = connects;
  await rejects('denied ad-hoc never contacts controller', () => limited.sessions.connect({ host: '10.3.0.1' }), 'HOST_NOT_ALLOWED');
  t.check('denied connect creates no handle or HTTP request', connects === beforeDenied && limited.devices.size === 1);
  const allowed = await limited.sessions.connect({ host: '10.2.3.4' });
  t.check('allowed ad-hoc connects', Boolean(allowed.session.sessionId));
  t.check('configured devices bypass ad-hoc allowlist', Boolean(await limited.sessions.use('mock-cam', (_c, id) => id)));
  await limited.close();
  t.check('empty allowlist denies every ad-hoc host', !hostAllowed('127.0.0.1', []));
} finally {
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
}

t.section('authenticated tools over MCP');
for (const token of ['t', 'wrong']) {
  const h = await startHarness({ appEnv: { CONTROLLER_TOKEN: 't' }, controllerToken: token });
  try {
    const result = h.json(await h.call('list_controllers'));
    const row = result.controllers[0];
    t.check(`list_controllers with ${token === 't' ? 'valid' : 'invalid'} token`, token === 't'
      ? row.reachable === true : row.reachable === false && row.error === 'CONTROLLER_UNAUTHORIZED');
    if (token === 't') t.check('authenticated camera session connects end-to-end', Boolean(await h.ctx.sessions.use('mock-cam', (_c, id) => id)));
  } finally { await h.close(); }
}
t.done();
