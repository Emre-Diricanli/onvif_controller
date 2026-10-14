/**
 * Wire-level regressions for ADAPTERS.md §7. Local ephemeral servers validate
 * actual headers, socket teardown and request counts, not just helper outputs.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import onvif from 'onvif';
import { AppError } from '../../server/errors.js';
import { createHttpClient, parseChallenges, digestAuthorization } from '../../server/transport/http.js';
import { withResourceLock, lockKey, lockStats } from '../../server/transport/lock.js';
import { getGovernor, governorStats, resetGovernor, withGovernor } from '../../server/device/governor.js';
import requestWithHttpDigest, { enableHttpDigest, hasHttpDigestTransport } from '../../server/onvif/http-digest.js';

const host = '127.0.0.1';
const credentials = { username: 'admin', password: 'secret-password' };
const governor = getGovernor(host, { minSpacingMs: 0, deadlineMs: 1000, breakerThreshold: 100, wedgeTimeouts: 100 });
const md5 = (value) => createHash('md5').update(value).digest('hex');
const fields = (header = '') => Object.fromEntries([...header.matchAll(/([\w-]+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)]
  .map((m) => [m[1], m[2]?.replace(/\\(.)/g, '$1') ?? m[3]]));
const challenge = (nonce = 'first', extra = '') => `Digest realm="camera", nonce="${nonce}", qop="auth"${extra}`;
const submitted = () => governorStats(host).submitted;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  resetGovernor(host);
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}:`, err); }
}

async function errorCode(promise, code) {
  let caught;
  try { await promise; } catch (err) { caught = err; }
  assert.ok(caught instanceof AppError, `expected AppError ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

async function serverTest(handler, fn, options = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers });
    handler(req, res, seen.length);
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  const client = createHttpClient({ host, port, ...credentials, ...options });
  try { await fn({ client, seen, port, server }); }
  finally {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function unauthorized(res, header = challenge(), status = 401) {
  res.writeHead(status, { 'WWW-Authenticate': header });
  res.end();
}

/** Independent server verification deliberately does not use transport helpers. */
function validDigest(req, password = credentials.password) {
  const f = fields(req.headers.authorization);
  if (!req.headers.authorization?.startsWith('Digest ') || f.username !== credentials.username || f.uri !== req.url) return false;
  let ha1 = md5(`${credentials.username}:${f.realm}:${password}`);
  if (f.algorithm?.toLowerCase() === 'md5-sess') ha1 = md5(`${ha1}:${f.nonce}:${f.cnonce}`);
  const ha2 = md5(`${req.method}:${req.url}`);
  return f.response === md5(f.qop ? `${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}` : `${ha1}:${f.nonce}:${ha2}`);
}

console.log('\ntransport');
await test('RFC 2617 §3.5 vector, MD5-sess and legacy no-qop vectors', async () => {
  // RFC 2617 §3.5: https://www.rfc-editor.org/rfc/rfc2617.html#section-3.5
  const input = {
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html',
    challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
    nc: 1, cnonce: '0a4f113b',
  };
  assert.equal(fields(digestAuthorization(input)).response, '6629fae49393a05397450978507c4ef1');
  assert.equal(fields(digestAuthorization({ ...input, challenge: { ...input.challenge, algorithm: 'MD5-sess' } })).response, '8e3825c57e897f5a0dec6c2d4e5059d0');
  const legacy = fields(digestAuthorization({ ...input, challenge: { ...input.challenge, qop: undefined } }));
  assert.equal(legacy.response, '670fd8c2df070c60b045671b8b24ff02');
  assert.equal(legacy.qop, undefined);
  assert.equal(legacy.nc, undefined);
  const sessionLegacy = fields(digestAuthorization({ ...input, challenge: { ...input.challenge, qop: undefined, algorithm: 'MD5-sess' } }));
  assert.equal(sessionLegacy.cnonce, input.cnonce);
  assert.equal(sessionLegacy.response, '4726bc10c33fa6cb357eb27807b1cce8');
  assert.throws(() => digestAuthorization({ ...input, challenge: { ...input.challenge, qop: 'auth-int' } }), { code: 'UNAUTHORIZED' });
  assert.throws(() => digestAuthorization({ ...input, nc: 0x100000000 }), { code: 'UNAUTHORIZED' });
});

await test('combined/multiple challenge headers, quoted commas and escapes', async () => {
  assert.deepEqual(parseChallenges(['Basic realm="plain", Digest realm="a, b\\"c", nonce="n", qop="auth,auth-int"', 'Digest realm = "other", nonce = "next"']), [
    { scheme: 'basic', realm: 'plain' },
    { scheme: 'digest', realm: 'a, b"c', nonce: 'n', qop: 'auth,auth-int' },
    { scheme: 'digest', realm: 'other', nonce: 'next' },
  ]);
});

for (const algorithm of ['MD5', 'MD5-sess', 'legacy', 'legacy-sess']) {
  await test(`${algorithm} authentication, nc increments, Digest preferred, exactly one submission per exchange`, () => serverTest((req, res) => {
    if (!validDigest(req)) {
      const header = algorithm.startsWith('legacy') ? `Digest realm="camera", nonce="first"${algorithm.endsWith('sess') ? ', algorithm=MD5-sess' : ''}`
        : challenge('first', `, algorithm=${algorithm}`);
      unauthorized(res, `Basic realm="plain", ${header}`);
    } else res.end('{"ok":true}');
  }, async ({ client, seen }) => {
    const before = submitted();
    assert.deepEqual((await client.request({ path: '/settings?channel=1' })).json(), { ok: true });
    await client.request({ path: '/settings?channel=2' });
    assert.equal(seen.length, 3);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.ok(seen[1].headers.authorization.startsWith('Digest '));
    if (!algorithm.startsWith('legacy')) {
      assert.equal(fields(seen[1].headers.authorization).nc, '00000001');
      assert.equal(fields(seen[2].headers.authorization).nc, '00000002');
    }
    assert.equal(submitted() - before, seen.length);
  }));
}

for (const mode of ['stale-new', 'stale-same', 'new']) {
  await test(`${mode} challenge after initial authentication retries once`, () => serverTest((req, res, count) => {
    if (count === 1) unauthorized(res);
    else if (count === 2) unauthorized(res, challenge(mode === 'stale-same' ? 'first' : 'second', mode.startsWith('stale') ? ', stale=true' : ''));
    else if (validDigest(req)) res.end('ok');
    else unauthorized(res);
  }, async ({ client, seen }) => {
    assert.equal((await client.request()).text, 'ok');
    assert.equal(seen.length, 3);
    assert.equal(fields(seen[2].headers.authorization).nc, mode === 'stale-same' ? '00000002' : '00000001');
  }));
}

await test('nonce counts survive rotation back to a previous nonce and concurrent requests', () => serverTest((req, res, count) => {
  if (count === 1 || count === 5) unauthorized(res);
  else if (count === 3) unauthorized(res, challenge('second'));
  else if (validDigest(req)) res.end('ok');
  else unauthorized(res);
}, async ({ client, seen }) => {
  await client.request();
  await client.request();
  await client.request();
  await Promise.all([client.request(), client.request()]);
  const auths = seen.slice(1).map((r) => fields(r.headers.authorization));
  assert.deepEqual(auths.filter((f) => f.nonce === 'first').map((f) => f.nc), ['00000001', '00000002', '00000003', '00000004', '00000005']);
}));

await test('nonce counts follow governor dispatch order when priorities reorder the queue', () => serverTest((req, res) => {
  if (!validDigest(req)) unauthorized(res);
  else res.end('ok');
}, async ({ client, seen }) => {
  await client.request();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blockers = [withGovernor(host, () => gate), withGovernor(host, () => gate)];
  const low = client.request({ path: '/low', priority: 9 });
  const high = client.request({ path: '/high', priority: 0 });
  release();
  await Promise.all([...blockers, low, high]);
  assert.deepEqual(seen.slice(2).map((r) => [r.path, fields(r.headers.authorization).nc]), [
    ['/high', '00000002'], ['/low', '00000003'],
  ]);
}));

for (const mode of ['wrong-password', 'endless-stale', 'endless-new']) {
  await test(`${mode} has a bounded authentication failure`, () => serverTest((_req, res, count) => {
    unauthorized(res, challenge(mode === 'endless-new' ? String(count) : 'first', mode === 'endless-stale' ? ', stale=true' : ''));
  }, async ({ client, seen }) => {
    const err = await errorCode(client.request({ path: '/?password=hidden' }), 'UNAUTHORIZED');
    assert.equal(seen.length, mode === 'wrong-password' ? 2 : 3);
    assert.ok(!err.message.includes('hidden'));
  }, { password: 'wrong' }));
}

for (const auth of ['auto', 'basic']) {
  await test(`${auth}: Basic only after a Basic challenge, never preemptive`, () => serverTest((req, res) => {
    if (req.headers.authorization === `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`) res.end('ok');
    else unauthorized(res, 'Basic realm="camera"');
  }, async ({ client, seen }) => {
    await client.request();
    await client.request();
    assert.equal(seen.length, 4);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[2].headers.authorization, undefined);
  }, { auth }));
}

await test('Digest-only refuses Basic; auth:none returns 401 without retry', () => serverTest((_req, res) => unauthorized(res, 'Basic realm="camera"'), async ({ client, seen, port }) => {
  await errorCode(client.request(), 'UNAUTHORIZED');
  assert.equal(seen.length, 1);
  const none = createHttpClient({ host, port, ...credentials, auth: 'none' });
  try { assert.equal((await none.request()).status, 401); } finally { none.close(); }
  assert.equal(seen.length, 2);
}, { auth: 'digest' }));

await test('unsupported Digest qop/algorithm never silently signs as MD5 or no-qop', () => serverTest((_req, res) => unauthorized(res, 'Digest realm="camera", nonce="n", algorithm=SHA-256, qop="auth-int"'), async ({ client, seen }) => {
  await errorCode(client.request(), 'UNAUTHORIZED');
  assert.equal(seen.length, 1);
}));

await test('string/Buffer/JSON lengths are byte-accurate and header names case-insensitive', () => serverTest((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), headers: req.headers })));
}, async ({ client }) => {
  for (const body of ['héllo', Buffer.from([65, 66, 67]), { name: '世界' }]) {
    const expected = Buffer.isBuffer(body) ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body);
    const r = (await client.request({ method: 'put', body, headers: { 'content-length': '999', 'Transfer-Encoding': 'chunked', 'content-type': 'application/custom' } })).json();
    assert.equal(r.body, expected);
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(expected));
    assert.equal(r.headers['transfer-encoding'], undefined);
    assert.equal(r.headers['content-type'], 'application/custom');
  }
  const r = (await client.request({ method: 'POST', body: { x: 1 } })).json();
  assert.equal(r.headers['content-type'], 'application/json');
  const cyclic = {}; cyclic.self = cyclic;
  await errorCode(client.request({ body: cyclic }), 'BAD_REQUEST');
}));

await test('chunked body limit destroys socket; exact limit is allowed', async () => {
  let closed;
  const socketClosed = new Promise((resolve) => { closed = resolve; });
  await serverTest((req, res) => {
    if (req.url === '/exact') { res.end('1234'); return; }
    req.socket.once('close', closed);
    res.writeHead(200);
    res.write('12345');
  }, async ({ client }) => {
    assert.equal((await client.request({ path: '/exact' })).text, '1234');
    await errorCode(client.request(), 'DEVICE_ERROR');
    await Promise.race([socketClosed, delay(1000).then(() => { throw new Error('socket not destroyed'); })]);
  }, { maxBodyBytes: 4 });
});

await test('oversized Content-Length rejected before buffering body', () => serverTest((_req, res) => {
  res.writeHead(200, { 'Content-Length': '100000' }); res.flushHeaders();
}, async ({ client }) => { await errorCode(client.request(), 'DEVICE_ERROR'); }, { maxBodyBytes: 4 }));

await test('timeout is DEVICE_TIMEOUT, including a response that trickles bytes', () => serverTest((_req, res) => {
  const timer = setInterval(() => res.write('.'), 5);
  res.on('close', () => clearInterval(timer));
}, async ({ client }) => {
  await errorCode(client.request({ timeoutMs: 35 }), 'DEVICE_TIMEOUT');
}));

await test('connection refused and reset map to DEVICE_UNREACHABLE', async () => {
  let port;
  await serverTest((_req, res) => res.end(), async (s) => { port = s.port; });
  const client = createHttpClient({ host, port, ...credentials });
  try { await errorCode(client.request(), 'DEVICE_UNREACHABLE'); } finally { client.close(); }
  await serverTest((req) => req.socket.destroy(), async ({ client: resetClient }) => {
    await errorCode(resetClient.request(), 'DEVICE_UNREACHABLE');
  });
});

await test('partial response reset is DEVICE_UNREACHABLE', () => serverTest((_req, res) => {
  res.writeHead(200, { 'Content-Length': '100' });
  res.write('partial');
  setImmediate(() => res.destroy());
}, async ({ client }) => { await errorCode(client.request(), 'DEVICE_UNREACHABLE'); }));

await test('redirects and vendor HTTP errors are returned without following or throwing', () => serverTest((_req, res, count) => {
  res.writeHead(count === 1 ? 302 : 500, { Location: '/elsewhere?token=redirect-secret' }); res.end('vendor-error');
}, async ({ client, seen }) => {
  assert.equal((await client.request()).status, 302);
  assert.equal(seen.length, 1);
  const error = await client.request();
  assert.equal(error.status, 500);
  assert.equal(error.text, 'vendor-error');
  await errorCode(Promise.resolve().then(() => error.json()), 'DEVICE_ERROR');
}));

await test('governor refusal is DEVICE_BUSY and sends no request', () => serverTest((_req, res) => res.end(), async ({ client, seen }) => {
  governor.markWedged('test refusal');
  await errorCode(client.request(), 'DEVICE_BUSY');
  assert.equal(seen.length, 0);
}));

await test('error messages omit password, Authorization and sensitive query values', () => serverTest((_req, res) => res.end('malformed secret-password'), async ({ client }) => {
  const path = '/?token=token-secret&password=password-secret&pwd=pwd-secret&passwd=passwd-secret&auth=auth-secret';
  const response = await client.request({ path });
  const errors = [await errorCode(Promise.resolve().then(() => response.json()), 'DEVICE_ERROR')];
  errors.push(await errorCode(client.request({ path, headers: { Authorization: 'Bearer secret-header\n' } }), 'BAD_REQUEST'));
  errors.push(await errorCode(client.request({ path: `${path}\n` }), 'BAD_REQUEST'));
  for (const err of errors) for (const secret of ['secret-password', 'secret-header', 'token-secret', 'password-secret', 'pwd-secret', 'passwd-secret', 'auth-secret', 'Authorization']) {
    assert.ok(!`${err.message} ${err.hint}`.includes(secret));
  }
}));

await test('abort before submission and during response releases the governor slot', () => serverTest((_req, res) => { res.writeHead(200); res.flushHeaders(); }, async ({ client, seen }) => {
  const already = new AbortController(); already.abort('token-secret');
  const before = submitted();
  await errorCode(client.request({ abortSignal: already.signal }), 'DEVICE_ERROR');
  assert.equal(submitted(), before);
  const controller = new AbortController();
  const result = errorCode(client.request({ abortSignal: controller.signal }), 'DEVICE_ERROR');
  await delay(20);
  controller.abort('password-secret');
  assert.ok(!(await result).message.includes('password-secret'));
  await delay(0);
  assert.equal(seen.length, 1);
  assert.equal(governorStats(host).inFlight, 0);
}));

await test('queued cancellation never opens a socket when the governor resumes', () => serverTest((_req, res) => res.end(), async ({ client, seen }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blockers = [withGovernor(host, () => gate), withGovernor(host, () => gate)];
  const controller = new AbortController();
  const result = errorCode(client.request({ abortSignal: controller.signal }), 'DEVICE_ERROR');
  controller.abort();
  await result;
  release();
  await Promise.all(blockers);
  await delay(0);
  assert.equal(seen.length, 0);
}));


await test('HTTPS verifies certificates by default and permits self-signed TLS only by explicit opt-in', async () => {
  // Public test fixture only, generated for loopback; never used as credentials.
  const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6uBQKcgd5piF6
CNP/NX72OPFaX/Cd+S9a96X1O7oDXeL2l1y9GMOwXJK8SJl3QEJX9tXbSq/el1ar
2cDZeGUfAntmMBMqA9FOr8RCyeELUxM6R+a/vsCYyQeSnv8gAOb1HVe/CcFGRewA
8zDKE6S3ul6dD8M0Gsek7vjfYwAmEft/tVdtN9GaOldtMpsOhH1SHqbCSNw5cDMF
cKn/SNHXp/dXJB67+2QmAhsADJcfXiF0iBk0C4g+KKklcQJwTOVgFI+1Hx6NNBhw
7J21b8H/1Rq/T3Ftp43QnxwB5LUQ1hjn9nz3ICPxnvlYhVIIjhhxeSDuC7nhCgkx
gDL4wtnFAgMBAAECggEAD/3AuaRKcs2BNt8xFaP426peZ7JC/HfHtnxYzXsjOZnK
dmDZ1tgbUMXQGCmflLb/XfxyrfVKwQv1DRxfh9obAizhCww5ZL/IjUfaAMS8oVuo
3RtYIW17N5qZkdUY97fo3KITgcKahIo4f1xUl8a9Tku7Dqu3uOt4oO3wIpgEyz2/
1F0MvVf55LbaqqPaGifT245qXEqRWepXOn4pLOpu8qFsVCVeqKa6StBiZJrBpfSc
MvQO2MZOZz1M7iVeeZrwKXWpoYerkv5DzeJlNRkQRNaWhw+BsbthkgHN+A3e3ejN
xQnZLLCet50IVYrszyfMEZzUeH3lX7kSFa3/24YlgQKBgQDusgjJIHoNHP5cUJDR
Nxu/9/ui912TtwqOBZpApvgr+p2tQkjHjSUKMDFXLfToTphQbm1Bmnz3uKXC+spy
FYz+msm8WDafcQCziVjhz8j4fYG1c6BxxC4MIXEJcMej0lDt85GwxkTQUsY1/0/d
7RAyDEkneQGd+WqPjsPg0PkUzwKBgQDIQWkTXzVDnlTSLVaNghXIlP9sroaJsQGd
ezaSlQMwpuACv7By27DaeUTsmw15EpqEMzE8mOJOOaqNyAcxPZFVyR0AbQytxC5E
iGzqZ+tuh9niC8Xzoy+mb/mH5ooR3+Kg1iBIGQ7D64T9LIt1QMqYweYjGkuXx+BX
ZNkc4uq1KwKBgAemBMoNFFwfNbdXjYxmq6j3FUUfkAwPrXLnkw3HS+R831iR6ysZ
xroQ2UPl4RcgjZjmMPINNTvq2sTorFwDfMUbyKMUYIuzX0ZhfEugENyFiQZ7cgSz
OJaC69BVoNALCTTWvTBg6guS228Xg0OlOQOhiSaOphKdz2BSPsyRZanZAoGBAJ3B
SbGFE0TNeiyIouKfU+HL3twTMNFPq+IPqpIW6YhuLZJ8x9fz0YKKfg2WqCp0yVzT
pzoBhmXxb7Z5mZDk25Uk9b/cKFzLa1d50bNnYkSUqMQ2Wh7wsxz+oSi6KJKkOLhT
duLVOpiE9SMs8D/SZseoGFAW6u4K+2RdgdwLtrI5AoGAA+uj+5q7CbbvLMRbR+GF
allMO9uGbMERg13ylyoFdmn/zdjK3i8Me8mfFtMuYOiL1/Jz86dyq5s890nBAq1Y
4TMY9EAC2MD6eKKHZWURqvJ+SWNhVCPLxHIWEuiyz0hIxyZtBLm6oiMSZXsmHdRR
V5KMYGeRcXO+bExEyhDL5ks=
-----END PRIVATE KEY-----`;
  const cert = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUYl71ha8ApQyEJ/UQEMzszbvNwAAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxNDE4MTczMVoYDzIxMjYw
OTIwMTgxNzMxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC6uBQKcgd5piF6CNP/NX72OPFaX/Cd+S9a96X1O7oD
XeL2l1y9GMOwXJK8SJl3QEJX9tXbSq/el1ar2cDZeGUfAntmMBMqA9FOr8RCyeEL
UxM6R+a/vsCYyQeSnv8gAOb1HVe/CcFGRewA8zDKE6S3ul6dD8M0Gsek7vjfYwAm
Eft/tVdtN9GaOldtMpsOhH1SHqbCSNw5cDMFcKn/SNHXp/dXJB67+2QmAhsADJcf
XiF0iBk0C4g+KKklcQJwTOVgFI+1Hx6NNBhw7J21b8H/1Rq/T3Ftp43QnxwB5LUQ
1hjn9nz3ICPxnvlYhVIIjhhxeSDuC7nhCgkxgDL4wtnFAgMBAAGjZDBiMB0GA1Ud
DgQWBBS7Ip1iVFh0Uj0zNMN5sQ8x8U3DnDAfBgNVHSMEGDAWgBS7Ip1iVFh0Uj0z
NMN5sQ8x8U3DnDAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAFmxEg5UYfyw0Wu1M7P34ZbiVZSp7+eaXoHyZoIcGPVd
a7kaPARNytnoVdJjvnQIX+XYBViSDmGY7vTvYrpJU5FcDs0XS/u/tyHRwEm3+Jt3
UxD+Oalz2enZKneviYFast6t1s8TtuPmo5VViXJFWh+jJZV6NBsd56Dgil7Wd0Xi
sp/YUNuaFpBkkbbkfJNl/IzLvuTLa3yiJOvJk5ilNuLPoJUhvsRAXEW6lnDzxTK5
jecByxTBQhIHfDesSVRMdclQQojEpQqaau++QPru+0wmXRI8wpQrs9H1YtcYTdf2
kUgS/sDAdVGZFygEBIPT4zVU6O4MkRqIk+A9G/Vw9f4=
-----END CERTIFICATE-----`;
  const server = https.createServer({ key, cert }, (_req, res) => res.end('secure'));
  await new Promise((resolve) => server.listen(0, host, resolve));
  const config = { host, port: server.address().port, scheme: 'https' };
  const secure = createHttpClient(config);
  const optedIn = createHttpClient({ ...config, insecureTls: true });
  try {
    await errorCode(secure.request(), 'DEVICE_UNREACHABLE');
    assert.equal((await optedIn.request()).text, 'secure');
  } finally {
    secure.close(); optedIn.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('close cancels active requests, is idempotent, and rejects later requests', () => serverTest((_req, res) => { res.writeHead(200); res.flushHeaders(); }, async ({ client }) => {
  const result = errorCode(client.request(), 'SESSION_EXPIRED');
  await delay(20);
  client.close(); client.close();
  await result;
  await errorCode(client.request(), 'SESSION_EXPIRED');
}));

await test('locks serialize same key, allow independent keys, and release on failure', async () => {
  const key = lockKey('CAMERA', 80, 'color');
  assert.equal(key, lockKey('camera', 80, 'color'));
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withResourceLock(key, async () => { order.push('start'); await gate; order.push('end'); throw new AppError('DEVICE_ERROR', 'owner failed'); });
  const failedOwner = errorCode(first, 'DEVICE_ERROR');
  const second = withResourceLock(key, async () => order.push('second'));
  await withResourceLock(lockKey('camera', 80, 'encoder'), async () => order.push('independent'));
  assert.deepEqual(lockStats(), [{ key, active: true, queued: 1 }]);
  release();
  await Promise.all([failedOwner, second]);
  assert.deepEqual(order, ['start', 'independent', 'end', 'second']);
  assert.deepEqual(lockStats(), []);
});

await test('lock deadlines remove waiters immediately and preserve surviving FIFO order', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const key = 'deadline';
  const owner = withResourceLock(key, () => gate);
  let ran = false;
  const expired = errorCode(withResourceLock(key, () => { ran = true; }, { waitMs: 10 }), 'DEVICE_BUSY');
  const order = [];
  const survivor = withResourceLock(key, () => order.push(1));
  const tailExpired = errorCode(withResourceLock(key, () => { ran = true; }, { waitMs: 15 }), 'DEVICE_BUSY');
  await Promise.all([expired, tailExpired]);
  assert.equal(lockStats()[0].queued, 1);
  const last = withResourceLock(key, () => order.push(2));
  release();
  await Promise.all([owner, survivor, last]);
  assert.equal(ran, false);
  assert.deepEqual(order, [1, 2]);
  await withResourceLock(key, () => 1, { waitMs: 0 });
  assert.deepEqual(lockStats(), []);
});

await test('ONVIF helper authenticates SOAP, preserves callback/body/URL and uses one slot per exchange', async () => {
  const soap = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformationResponse xmlns="http://www.onvif.org/ver10/device/wsdl"><Manufacturer>TransportTest</Manufacturer></GetDeviceInformationResponse></s:Body></s:Envelope>';
  const bodies = [];
  await serverTest((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString());
      if (!validDigest(req)) unauthorized(res, `Basic realm="plain", ${challenge('soap', ', algorithm=MD5-sess')}`);
      else { res.setHeader('Content-Type', 'application/soap+xml'); res.end(soap); }
    });
  }, async ({ port, seen }) => {
    const cam = new onvif.Cam({ hostname: host, port, ...credentials, autoconnect: false, timeout: 1000 });
    const body = cam._envelopeHeader() + '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>' + cam._envelopeFooter();
    const options = { body, url: { hostname: host, port, path: '/soap?channel=2' } };
    const before = submitted();
    const result = await requestWithHttpDigest(cam, options);
    assert.ifError(result.err);
    assert.equal(result.statusCode, 200);
    assert.equal(result.data[0].getDeviceInformationResponse[0].manufacturer[0], 'TransportTest');
    assert.ok(result.xml.includes('TransportTest'));
    const originalRequest = cam._request;
    const restore = enableHttpDigest(cam);
    assert.equal(enableHttpDigest(cam), restore);
    assert.equal(hasHttpDigestTransport(cam), true);
    const callbackResult = await new Promise((resolve, reject) => cam._request(options, function (err, data, xml, status) {
      if (err) reject(err);
      else resolve({ data, xml, status, context: this });
    }));
    assert.equal(callbackResult.status, 200);
    assert.equal(callbackResult.context, cam);
    assert.equal(seen.length, 4);
    assert.equal(submitted() - before, 4);
    assert.equal(fields(seen[3].headers.authorization).nc, '00000002');
    assert.ok(seen.every((r) => r.path === '/soap?channel=2'));
    assert.ok(bodies.every((b) => b === body));
    restore(); restore();
    assert.equal(cam._request, originalRequest);
    assert.equal(hasHttpDigestTransport(cam), false);
  });
});

for (const mode of ['wrong', 'stale', 'new', 'endless']) {
  await test(`ONVIF helper ${mode} retry bounds and original-error behavior`, () => serverTest((req, res, count) => {
    if (count === 1 || mode === 'wrong') unauthorized(res, challenge(), 400);
    else if (count === 2 || mode === 'endless') unauthorized(res, challenge(String(count), mode === 'new' ? '' : ', stale=true'));
    else res.end('<Envelope><Body><OK/></Body></Envelope>');
  }, async ({ port, seen }) => {
    const cam = new onvif.Cam({ hostname: host, port, ...credentials, autoconnect: false, timeout: 1000 });
    const result = await requestWithHttpDigest(cam, { body: '<Envelope><Body><Test/></Body></Envelope>', action: 'test' });
    assert.equal(seen.length, mode === 'wrong' ? 2 : 3);
    if (['wrong', 'endless'].includes(mode)) { assert.equal(result.statusCode, 400); assert.ok(result.err); }
    else assert.equal(result.statusCode, 200);
  }));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
