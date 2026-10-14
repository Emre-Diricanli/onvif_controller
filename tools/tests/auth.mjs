/** Exercise the real HTTP gate and both WebSocket upgrade paths. */
import crypto from 'node:crypto';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import WebSocket from 'ws';
import { startHarness, createChecker } from '../../mcp/test/harness.mjs';
import { createAuth, sameSecret } from '../../server/auth.js';

const t = createChecker('controller authentication');
const token = 'controller-test-secret';

async function upgrade(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    ws.on('error', reject);
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
  });
}

/** Observe the builtin call rather than guessing constant-time behavior from elapsed time. */
const original = crypto.timingSafeEqual;
let comparisons = 0;
crypto.timingSafeEqual = (...args) => { comparisons += 1; return original(...args); };
syncBuiltinESMExports();
try {
  t.check('equal-length wrong bearer takes timingSafeEqual path', !sameSecret('bad', 'yes') && comparisons === 1);
  t.check('unequal lengths safely reject before comparing', !sameSecret('b', 'yes') && comparisons === 1);
} finally {
  crypto.timingSafeEqual = original;
  syncBuiltinESMExports();
}

const h = await startHarness({ appEnv: { CONTROLLER_TOKEN: token }, controllerToken: token });
try {
  const get = (path, opts = {}) => fetch(`${h.appUrl}${path}`, { redirect: 'manual', ...opts });
  const absoluteStatus = await new Promise((resolve, reject) => {
    const req = http.get(h.appUrl, { path: `${h.appUrl}/api/adapters` }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  t.check('absolute-form proxy requests cannot bypass API auth', absoluteStatus === 401);
  t.check('health stays open', (await get('/api/health')).status === 200);
  t.check('HEAD health stays open', (await get('/api/health', { method: 'HEAD' })).status === 200);
  const denied = await get('/api/adapters');
  const error = await denied.json();
  t.check('API without auth uses 401 envelope', denied.status === 401 && error.error.code === 'UNAUTHORIZED' && Boolean(error.error.hint));
  t.check('correct bearer authorizes', (await get('/api/adapters', { headers: { Authorization: `Bearer ${token}` } })).status === 200);
  t.check('wrong equal-length bearer rejected', (await get('/api/adapters', { headers: { Authorization: `Bearer ${'x'.repeat(token.length)}` } })).status === 401);
  t.check('static UI stays public', (await get('/')).status === 200);
  const bad = await get('/?token=wrong');
  t.check('invalid browser token gets 401 page without cookie', bad.status === 401 && /text\/html/.test(bad.headers.get('content-type')) && !bad.headers.get('set-cookie'));
  const login = await get(`/index.html?keep=1&token=${token}&token=discard`);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  t.check('login removes tokens and preserves static path/query', login.status === 302 && login.headers.get('location') === '/index.html?keep=1');
  t.check('cookie is HttpOnly, Strict, Path=/ and never raw token', /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Path=\//.test(setCookie) && !setCookie.includes(token));
  t.check('login response is not cached', login.headers.get('cache-control') === 'no-store');
  t.check('cookie authorizes API', (await get('/api/adapters', { headers: { Cookie: cookie } })).status === 200);
  t.check('tampered cookie is denied', (await get('/api/adapters', { headers: { Cookie: `${cookie}x` } })).status === 401);
  t.check('cookie cannot survive another process key', !createAuth(token).authorized({ headers: { cookie } }));
  const slash = await get(`//elsewhere.example/?token=${token}`);
  t.check('login cannot redirect to another origin', slash.headers.get('location') === '/elsewhere.example/');
  for (const path of ['/ws/events', '/ws/stream']) {
    const url = h.appUrl.replace('http:', 'ws:') + path;
    t.check(`${path} denies missing auth`, await upgrade(url) === 401);
    t.check(`${path} denies wrong auth`, await upgrade(url, { Authorization: 'Bearer wrong' }) === 401);
    t.check(`${path} accepts bearer upgrade`, await upgrade(url, { Authorization: `Bearer ${token}` }) === 101);
    t.check(`${path} accepts cookie upgrade`, await upgrade(url, { Cookie: cookie }) === 101);
    t.check(`${path} keeps origin checks`, await upgrade(url, { Cookie: cookie, Origin: 'http://untrusted.example' }) === 403);
  }
} finally { await h.close(); }

const open = await startHarness({ appEnv: { CONTROLLER_TOKEN: '' } });
try {
  t.check('unset token preserves public API', (await fetch(`${open.appUrl}/api/adapters`)).status === 200);
  const login = await fetch(`${open.appUrl}/?token=ignored`, { redirect: 'manual' });
  t.check('unset token leaves query behavior unchanged', login.status === 200 && !login.headers.get('set-cookie'));
  for (const path of ['/ws/events', '/ws/stream']) {
    t.check(`unset token preserves ${path}`, await upgrade(open.appUrl.replace('http:', 'ws:') + path) === 101);
  }
} finally { await open.close(); }
t.done();
