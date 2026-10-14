/**
 * Self-test for the adapter harness, the governed transport, the resource
 * lock and the shared write semantics — using a tiny reference adapter and
 * persona defined inline. Doubles as the worked example for ADAPTERS.md:
 * a real adapter in server/adapters/<id>/index.js follows the same shape.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../server/errors.js';
import { createHttpClient } from '../../server/transport/http.js';
import { withResourceLock, lockKey } from '../../server/transport/lock.js';
import { validatePatch, verifyWrite, classify, allUnchanged } from '../../server/settings/contract.js';
import { createChecker, runConformance } from '../adapter-harness.mjs';

// ---------------------------------------------------------------- persona
const md5 = (s) => createHash('md5').update(s).digest('hex');

const persona = {
  name: 'example-cam',
  vendor: 'example',
  create(ctx) {
    const realm = 'ExampleCam';
    const nonce = randomBytes(8).toString('hex');
    const state = { brightness: 50, mirror: false, dayNight: 'auto' };
    const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };

    function authorized(req) {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Digest ')) return false;
      const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      if (f.username !== ctx.username) return false;
      const ha1 = md5(`${ctx.username}:${realm}:${ctx.password}`);
      const ha2 = md5(`${req.method}:${f.uri}`);
      return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
    }

    return {
      onRequest(req, res) {
        if (!req.url.startsWith('/example/')) return false;
        if (!authorized(req)) {
          res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` });
          res.end();
          return true;
        }
        if (req.url === '/example/info' && req.method === 'GET') {
          count('info');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ vendor: 'Example', model: 'EX-1', firmware: '1.0' }));
          return true;
        }
        if (req.url === '/example/image' && req.method === 'GET') {
          count('image.get');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state));
          return true;
        }
        if (req.url === '/example/image' && req.method === 'PUT') {
          count('image.put');
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            const next = JSON.parse(body);
            // Whole-object PUT, like ISAPI: a missing field is an error.
            if (Object.keys(state).some((k) => !(k in next))) {
              res.writeHead(400); res.end('{"error":"incomplete object"}'); return;
            }
            if (ctx.mode !== 'ignore') Object.assign(state, next);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
          return true;
        }
        return false;
      },
    };
  },
};

// ---------------------------------------------------------------- adapter
const NATIVE = { 'image.brightness': 'brightness', 'image.mirror': 'mirror', 'image.dayNight': 'dayNight' };
const DESCRIPTORS = [
  { key: 'image.brightness', label: 'Brightness', group: 'imaging', type: 'int', unit: null, min: 0, max: 100, step: 1, writable: true, resource: 'image' },
  { key: 'image.mirror', label: 'Mirror', group: 'imaging', type: 'bool', unit: null, writable: true, resource: 'image' },
  { key: 'image.dayNight', label: 'Day/Night', group: 'imaging', type: 'enum', unit: null, values: ['auto', 'day', 'night'], writable: true, resource: 'image' },
];

const adapter = {
  id: 'example',
  label: 'Example reference adapter',
  priority: 90,
  defaultPorts: [80],
  async probe(config) {
    const client = createHttpClient({ ...config, timeoutMs: config.timeoutMs ?? 3000 });
    try {
      const res = await client.request({ path: '/example/info' });
      const body = res.status === 200 ? res.json() : null;
      return body?.vendor === 'Example' ? { match: true, confidence: 0.95, model: body.model, firmware: body.firmware } : { match: false, confidence: 0 };
    } catch (err) {
      // Wrong credentials still prove the vendor if the realm is ours.
      return { match: false, confidence: 0 };
    } finally {
      client.close();
    }
  },
  async connect(config) {
    const client = createHttpClient(config);
    const info = (await client.request({ path: '/example/info' })).json();
    const TARGET = { id: 'channel:1', scope: 'channel', label: 'Camera', channel: 1 };
    const requireTarget = (targetId) => {
      if (targetId !== TARGET.id) throw new AppError('NOT_FOUND', `No target "${targetId}".`);
    };
    const readNative = async () => (await client.request({ path: '/example/image' })).json();
    const toValues = (native, keys = Object.keys(NATIVE)) => Object.fromEntries(keys.map((k) => [k, native[NATIVE[k]]]));
    return {
      id: 'example',
      label: 'Example reference adapter',
      info: { vendor: info.vendor, model: info.model, firmware: info.firmware, serial: null },
      async listTargets() { return [TARGET]; },
      async describeSettings(targetId) { requireTarget(targetId); return DESCRIPTORS; },
      async read(targetId, keys) {
        requireTarget(targetId);
        return { values: toValues(await readNative(), keys ?? Object.keys(NATIVE)), source: 'example' };
      },
      async write(targetId, patch) {
        requireTarget(targetId);
        const used = validatePatch(patch, DESCRIPTORS);
        return withResourceLock(lockKey(config.host, config.port, 'image'), async () => {
          const current = await readNative();
          const before = toValues(current, Object.keys(patch));
          const next = { ...current };
          for (const [k, v] of Object.entries(patch)) next[NATIVE[k]] = v;
          const res = await client.request({ method: 'PUT', path: '/example/image', body: next });
          const rejected = res.status >= 400 ? Object.keys(patch) : [];
          return verifyWrite({
            patch, before, descriptors: used, rejected, source: 'example',
            readBack: async () => toValues(await readNative(), Object.keys(patch)),
          });
        });
      },
      close() { client.close(); },
    };
  },
};

// ---------------------------------------------------------------- checks
const t = createChecker('harness self-test');

t.section('contract semantics');
t.check('classify applied', classify({ requested: 5, before: 1, observed: 5 }) === 'applied');
t.check('classify adjusted', classify({ requested: 101, before: 1, observed: 100 }) === 'adjusted');
t.check('classify unchanged', classify({ requested: 5, before: 1, observed: 1 }) === 'unchanged');
t.check('classify unknown', classify({ requested: 5, before: 1, observed: undefined }) === 'unknown');
t.check('step tolerance', classify({ requested: 0.5, before: 0, observed: 0.6, descriptor: { step: 0.25 } }) === 'applied');
t.check('allUnchanged only when every field is unchanged',
  allUnchanged({ results: { a: { outcome: 'unchanged' }, b: { outcome: 'unchanged' } } })
  && !allUnchanged({ results: { a: { outcome: 'unchanged' }, b: { outcome: 'applied' } } })
  && !allUnchanged({ results: {} }));
const failing = await verifyWrite({ patch: { a: 1 }, before: { a: 0 }, readBack: async () => { throw new Error('x'); }, delays: [1, 1] });
t.check('read-back that always throws -> unknown, never applied', failing.results.a.outcome === 'unknown');
const refused = await verifyWrite({ patch: { a: 1, b: 2 }, before: { a: 0, b: 0 }, rejected: ['b'], readBack: async () => ({ a: 1, b: 0 }), delays: [1] });
t.check('explicitly refused field -> rejected', refused.results.b.outcome === 'rejected' && refused.results.a.outcome === 'applied');
let threw = null;
try { validatePatch({ x: 1 }, DESCRIPTORS); } catch (err) { threw = err; }
t.check('validatePatch: unknown key is BAD_REQUEST', threw?.code === 'BAD_REQUEST');
threw = null;
try { validatePatch({ 'image.dayNight': 'dusk' }, DESCRIPTORS); } catch (err) { threw = err; }
t.check('validatePatch: bad enum is BAD_REQUEST', threw?.code === 'BAD_REQUEST');

t.section('resource lock');
const order = [];
const key = lockKey('10.0.0.1', 80, 'image');
await Promise.all([
  withResourceLock(key, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 30)); order.push('a2'); }),
  withResourceLock(key, async () => { order.push('b1'); order.push('b2'); }),
]);
t.check('same resource is serialized', order.join(',') === 'a1,a2,b1,b2', order.join(','));

await runConformance(t, { adapter, persona, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });

t.done();
