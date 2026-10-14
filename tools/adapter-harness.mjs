/**
 * Adapter conformance harness (ADAPTERS.md §8).
 *
 * Boots a vendor persona on a scratch port and drives an adapter through the
 * contract. A pass makes a driver "mock-verified" — it proves the adapter
 * honours the contract against what the persona encodes, not that a given
 * firmware behaves that way.
 */
import http from 'node:http';
import net from 'node:net';
import { AppError } from '../server/errors.js';
import { SCOPES, descriptorProblems, OUTCOMES } from '../server/settings/contract.js';
import { governorStats } from '../server/device/governor.js';
import { clearProbeCache } from '../server/adapters/index.js';

export const HARNESS_CREDENTIALS = Object.freeze({ username: 'admin', password: 'Harness-Pass1' });

export function createChecker(title) {
  let passed = 0;
  let failed = 0;
  console.log(`\n${title}`);
  return {
    check(name, ok, detail = '') {
      if (ok) { passed += 1; console.log(`  ok   ${name}`); }
      else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
      return Boolean(ok);
    },
    section(name) { console.log(`\n${name}`); },
    get failed() { return failed; },
    done() {
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed) process.exitCode = 1;
      return failed === 0;
    },
  };
}

/** Start a persona as a standalone HTTP server. Unhandled requests get 404. */
export async function startPersona(persona, { mode = 'default', username = HARNESS_CREDENTIALS.username, password = HARNESS_CREDENTIALS.password, extra = {} } = {}) {
  const callCounts = {};
  let hooks = null;
  const server = http.createServer((req, res) => {
    try {
      if (hooks?.onRequest?.(req, res)) return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`persona threw: ${err?.message ?? err}`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const ctx = { HOST: '127.0.0.1', PORT: port, mode, username, password, callCounts, ...extra };
  hooks = persona.create(ctx);
  return {
    host: '127.0.0.1',
    port,
    ctx,
    callCounts,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** A server that answers everything with a plain 404 — no vendor should match it. */
export async function startNotFoundServer() {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('Not Found'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/** A port with nothing listening. */
export async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function expectAppError(promise, code) {
  try {
    await promise;
    return { ok: false, detail: 'did not throw' };
  } catch (err) {
    if (err instanceof AppError && err.code === code) return { ok: true };
    return { ok: false, detail: `threw ${err?.code ?? err?.name}: ${err?.message}` };
  }
}

function submittedFor(host) {
  return governorStats(host)?.submitted ?? 0;
}

/**
 * The generic contract checks. `sample` names one writable setting:
 *   { scope, key, value, outOfRange? }
 * `value` must differ from the persona's default. `outOfRange` defaults to
 * descriptor.max + 1000 for numeric keys.
 */
export async function runConformance(t, { adapter, persona, sample, credentials = HARNESS_CREDENTIALS, timeoutMs = 4000 }) {
  const id = adapter.id;
  t.section(`conformance: ${id} against persona ${persona.name}`);

  t.check(`${id}: exports id matching /^[a-z][a-z0-9-]*$/`, typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id));
  t.check(`${id}: exports label`, typeof adapter.label === 'string' && adapter.label.length > 0);
  t.check(`${id}: exports numeric priority`, typeof adapter.priority === 'number');
  t.check(`${id}: exports probe and connect`, typeof adapter.probe === 'function' && typeof adapter.connect === 'function');
  t.check(`${id}: persona declares vendor = adapter id`, persona.vendor === id, `persona.vendor=${persona.vendor}`);
  t.check(`${id}: persona supports mode via ctx`, typeof persona.create === 'function');

  clearProbeCache();
  const dev = await startPersona(persona, { ...credentials });
  const config = { host: dev.host, port: dev.port, ...credentials, timeoutMs };
  let conn = null;
  try {
    // --- probe ---
    const before = submittedFor(dev.host);
    const probed = await adapter.probe(config).catch((err) => ({ threw: err }));
    t.check(`${id}: probe matches its persona`, probed?.match === true, JSON.stringify(probed));
    t.check(`${id}: probe confidence is 0..1`, typeof probed?.confidence === 'number' && probed.confidence >= 0 && probed.confidence <= 1);
    t.check(`${id}: probe traffic goes through the governor`, submittedFor(dev.host) > before,
      'no governor submissions — the adapter is bypassing server/transport/http.js');

    const nf = await startNotFoundServer();
    const p404 = await adapter.probe({ ...config, port: nf.port }).catch((err) => ({ threw: err }));
    t.check(`${id}: probe does not match a plain 404 server`, p404?.match === false, JSON.stringify(p404));
    await nf.close();
    const pClosed = await adapter.probe({ ...config, port: await closedPort() }).catch((err) => ({ threw: err }));
    t.check(`${id}: probe against a closed port returns match:false without throwing`, pClosed?.match === false && !pClosed?.threw);

    // --- wrong password ---
    const bad = await expectAppError(adapter.connect({ ...config, password: 'definitely-wrong' }), 'UNAUTHORIZED');
    t.check(`${id}: wrong password -> UNAUTHORIZED`, bad.ok, bad.detail);

    // --- connect + targets ---
    conn = await adapter.connect(config);
    t.check(`${id}: connection has info`, conn && typeof conn.info === 'object');
    const targets = await conn.listTargets();
    t.check(`${id}: listTargets returns a non-empty array`, Array.isArray(targets) && targets.length > 0);
    const badTargets = targets.filter((x) => typeof x.id !== 'string' || !SCOPES.includes(x.scope) || typeof x.label !== 'string');
    t.check(`${id}: every target has id/scope/label`, badTargets.length === 0, JSON.stringify(badTargets[0]));

    const target = targets.find((x) => x.scope === sample.scope);
    t.check(`${id}: has a ${sample.scope} target for the sample`, Boolean(target));
    if (!target) return;

    const notFound = await expectAppError(conn.describeSettings('no-such-target'), 'NOT_FOUND');
    t.check(`${id}: unknown target -> NOT_FOUND`, notFound.ok, notFound.detail);

    let allProblems = [];
    for (const x of targets) {
      const ds = await conn.describeSettings(x.id);
      for (const d of ds) allProblems = allProblems.concat(descriptorProblems(d, id));
    }
    t.check(`${id}: every descriptor honours ADAPTERS.md §3`, allProblems.length === 0, allProblems.slice(0, 3).join('; '));

    const descriptors = await conn.describeSettings(target.id);
    const d = descriptors.find((x) => x.key === sample.key);
    t.check(`${id}: describes ${sample.key} as writable`, d?.writable === true);

    const read = await conn.read(target.id);
    t.check(`${id}: read returns values and source`, read && typeof read.values === 'object' && read.source === id);
    const readableKeys = descriptors.map((x) => x.key);
    const stray = Object.keys(read?.values ?? {}).filter((k) => !readableKeys.includes(k));
    t.check(`${id}: read returns only described keys`, stray.length === 0, stray.join(','));
    t.check(`${id}: sample value differs from the current value`, read?.values?.[sample.key] !== sample.value,
      'pick a sample value that differs from the persona default');

    // --- writes ---
    const unknownKey = await expectAppError(conn.write(target.id, { 'vendor.nobody.nothing': 1 }), 'BAD_REQUEST');
    t.check(`${id}: unknown key -> BAD_REQUEST`, unknownKey.ok, unknownKey.detail);
    if (d && (d.type === 'int' || d.type === 'number')) {
      const oor = sample.outOfRange ?? (d.max ?? 1e6) + 1000;
      const out = await expectAppError(conn.write(target.id, { [sample.key]: oor }), 'BAD_REQUEST');
      t.check(`${id}: out-of-range value -> BAD_REQUEST`, out.ok, out.detail);
    }

    const writeCountBefore = Object.values(dev.callCounts).reduce((a, b) => a + b, 0);
    const w = await conn.write(target.id, { [sample.key]: sample.value });
    const r = w?.results?.[sample.key];
    t.check(`${id}: write result has source`, w?.source === id);
    t.check(`${id}: write outcome is in the enum`, OUTCOMES.includes(r?.outcome), JSON.stringify(r));
    t.check(`${id}: write of ${sample.key}=${JSON.stringify(sample.value)} is applied`, r?.outcome === 'applied', JSON.stringify(r));
    const after = await conn.read(target.id, [sample.key]);
    t.check(`${id}: independent read-back shows the new value`, after?.values?.[sample.key] === sample.value,
      JSON.stringify(after?.values));
    t.check(`${id}: persona recorded the traffic (callCounts)`,
      Object.values(dev.callCounts).reduce((a, b) => a + b, 0) > writeCountBefore,
      'personas must count calls in ctx.callCounts');
  } catch (err) {
    t.check(`${id}: conformance ran without throwing`, false, `${err?.code ?? ''} ${err?.message ?? err}`);
  } finally {
    try { conn?.close(); } catch { /* close must not throw */ }
    await dev.close();
  }

  // --- ignore mode: the stub signature must surface as `unchanged` ---
  const stub = await startPersona(persona, { ...credentials, mode: 'ignore' });
  let stubConn = null;
  try {
    stubConn = await adapter.connect({ host: stub.host, port: stub.port, ...credentials, timeoutMs });
    const target = (await stubConn.listTargets()).find((x) => x.scope === sample.scope);
    const w = await stubConn.write(target.id, { [sample.key]: sample.value });
    t.check(`${id}: ignore mode -> outcome "unchanged", never "applied"`,
      w?.results?.[sample.key]?.outcome === 'unchanged', JSON.stringify(w?.results));
  } catch (err) {
    t.check(`${id}: ignore-mode check ran without throwing`, false, `${err?.code ?? ''} ${err?.message ?? err}`);
  } finally {
    try { stubConn?.close(); } catch { /* close must not throw */ }
    await stub.close();
  }
}
