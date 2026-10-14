/**
 * MCP Streamable HTTP transport (mcp/index.js --http): the path a remote agent
 * uses. Checks the loopback default, the MCP_HTTP_TOKEN gate, the refusal to
 * bind a non-loopback address without a token, and a real tools/call.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, createChecker, freePort } from '../../mcp/test/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const t = createChecker('mcp streamable http');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

function startMcp(args, env) {
  const child = spawn(process.execPath, ['mcp/index.js', '--http', ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  children.push(child);
  return { child, stderr: () => err };
}

async function rpc(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const textBody = await res.text();
  // Streamable HTTP may answer as SSE; take the last data: line.
  const data = textBody.includes('data:') ? textBody.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : textBody;
  let json = null;
  try { json = JSON.parse(data); } catch { /* not json */ }
  return { status: res.status, json };
}

async function waitListening(proc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/Streamable HTTP/.test(proc.stderr())) return true;
    if (proc.child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

const h = await startHarness();
try {
  t.section('non-loopback bind requires a token');
  {
    const p = startMcp(['--host', '0.0.0.0', '--port', String(await freePort())], { ONVIF_CONTROLLER_URL: h.appUrl, MCP_HTTP_TOKEN: '' });
    await new Promise((r) => p.child.once('exit', r));
    t.check('refuses 0.0.0.0 without MCP_HTTP_TOKEN', p.child.exitCode === 1 && /MCP_HTTP_TOKEN/.test(p.stderr()), p.stderr());
  }

  t.section('loopback, with a token');
  const port = await freePort();
  const p = startMcp(['--port', String(port)], { ONVIF_CONTROLLER_URL: h.appUrl, MCP_HTTP_TOKEN: 's3cret-token' });
  t.check('server starts', await waitListening(p), p.stderr());
  const url = `http://127.0.0.1:${port}/mcp`;
  const noAuth = await rpc(url, init);
  t.check('missing token -> 401', noAuth.status === 401);
  const badAuth = await rpc(url, init, { Authorization: 'Bearer nope' });
  t.check('wrong token -> 401', badAuth.status === 401);
  const auth = { Authorization: 'Bearer s3cret-token' };
  const ok = await rpc(url, init, auth);
  t.check('initialize succeeds with the token', ok.status === 200 && ok.json?.result?.serverInfo?.name === 'onvif-controller', JSON.stringify(ok));
  const list = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
  t.check('tools/list works statelessly', list.json?.result?.tools?.some((x) => x.name === 'list_controllers'));
  const call = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_controllers', arguments: {} } }, auth);
  const payload = call.json?.result?.content?.[0]?.text ? JSON.parse(call.json.result.content[0].text) : null;
  t.check('tools/call reaches the controller over HTTP', payload?.controllers?.[0]?.reachable === true, JSON.stringify(call.json).slice(0, 300));
  const other = await fetch(`http://127.0.0.1:${port}/other`);
  t.check('only /mcp is served', other.status === 404);
} finally {
  await h.close();
}

t.done();
process.exit(t.failed ? 1 : 0);
