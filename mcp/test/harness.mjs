/**
 * MCP test harness (MCP.md §8).
 *
 * Boots a mock ONVIF camera and a real controller on free ports, builds the
 * MCP context against it, and connects an SDK Client over InMemoryTransport,
 * so tests call tools exactly the way an agent does: schemas, annotations,
 * the confirm gate and error mapping included.
 *
 *   const h = await startHarness();
 *   const r = await h.call('read_settings', { device: 'mock-cam', target: … });
 *   h.json(r); await h.close();
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext } from '../lib/context.js';
import { createMcpServer } from '../server.js';

// Re-exported so tests under tools/tests/ (outside the mcp package) resolve
// mcp's own dependencies through this module.
export { z } from 'zod';
export { Client, InMemoryTransport };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitFor(url, headers = {}, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { headers })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * @param {object} opts
 *   appEnv       extra env for the controller (e.g. { CONTROLLER_TOKEN })
 *   mockEnv      extra env for the mock camera (e.g. { MOCK_IMAGING_MODE: 'ignore' })
 *   config       extra config merged into the generated one (controllers/devices appended)
 *   controllerToken  token the MCP context sends to the controller
 *   readOnly     run the context in read-only mode
 */
export async function startHarness({ appEnv = {}, mockEnv = {}, config = {}, controllerToken = null, readOnly = false } = {}) {
  const children = [];
  const spawnNode = (args, env) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
    child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
    children.push(child);
    return child;
  };

  const mockPort = await freePort();
  const appPort = await freePort();
  spawnNode(['tools/mock-camera.js', String(mockPort)], mockEnv);
  spawnNode(['server/index.js'], {
    PORT: String(appPort), HOST: '127.0.0.1', FFMPEG_PATH: path.join(ROOT, 'tools/fake-ffmpeg.mjs'), ...appEnv,
  });
  const appUrl = `http://127.0.0.1:${appPort}`;
  if (!await waitFor(`${appUrl}/api/health`)) throw new Error('controller did not start (run with VERBOSE=1)');

  const fullConfig = {
    controllers: [{ name: 'local', url: appUrl, token: controllerToken }, ...(config.controllers ?? [])],
    devices: [
      { name: 'mock-cam', controller: 'local', host: '127.0.0.1', port: mockPort, username: 'admin', password: 'admin',
        label: 'Mock camera', notes: 'Test fixture: the mock ONVIF camera from tools/mock-camera.js.' },
      ...(config.devices ?? []),
    ],
    defaultController: 'local',
  };
  const previous = process.env.MCP_READ_ONLY;
  if (readOnly) process.env.MCP_READ_ONLY = '1'; else delete process.env.MCP_READ_ONLY;
  const logs = [];
  const ctx = createContext(fullConfig, { log: (level, msg) => logs.push(`${level} ${msg}`) });
  if (previous === undefined) delete process.env.MCP_READ_ONLY; else process.env.MCP_READ_ONLY = previous;

  const server = await createMcpServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'harness', version: '0.0.0' });
  await client.connect(clientSide);

  return {
    ctx, client, server, appUrl, mockPort, logs,
    async listTools() { return (await client.listTools()).tools; },
    call(name, args = {}) { return client.callTool({ name, arguments: args }); },
    text(res) { return (res?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'); },
    json(res) {
      const block = (res?.content ?? []).find((b) => b.type === 'text');
      return block ? JSON.parse(block.text) : null;
    },
    async close() {
      await ctx.close().catch(() => {});
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    },
  };
}

/** Same checker shape as tools/adapter-harness.mjs. */
export function createChecker(title) {
  let passed = 0;
  let failed = 0;
  console.log(`\n${title}`);
  return {
    check(name, ok, detail = '') {
      if (ok) { passed += 1; console.log(`  ok   ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
      return Boolean(ok);
    },
    section(name) { console.log(`\n${name}`); },
    get failed() { return failed; },
    done() { console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; return failed === 0; },
  };
}
