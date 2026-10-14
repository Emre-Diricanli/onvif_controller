/**
 * MCP core: registration, annotations, the confirm gate, read-only mode, error
 * mapping and the stdio entry point, driven through the MCP protocol.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, createChecker, z, Client, InMemoryTransport } from '../../mcp/test/harness.mjs';
import { createContext } from '../../mcp/lib/context.js';
import { createMcpServer, loadTools } from '../../mcp/server.js';
import { defineTool, result, text, ToolError, scrub } from '../../mcp/lib/kit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const t = createChecker('mcp core');

t.section('tool modules');
const all = await loadTools();
t.check('tool modules load', all.length > 0);
t.check('every tool has a real description', all.every((d) => d.description.length >= 40), all.filter((d) => d.description.length < 40).map((d) => d.name).join(','));
t.check('every tool declares readOnly or not explicitly',
  all.every((d) => typeof d.annotations.readOnlyHint === 'boolean' || typeof d.annotations.destructiveHint === 'boolean'),
  all.filter((d) => typeof d.annotations.readOnlyHint !== 'boolean' && typeof d.annotations.destructiveHint !== 'boolean').map((d) => d.name).join(','));
t.check('every input field is described', all.every((d) => Object.values(d.inputSchema).every((s) => s.description)),
  all.filter((d) => Object.values(d.inputSchema).some((s) => !s.description)).map((d) => d.name).join(','));

t.section('kit');
t.check('scrub hides credentialed URLs', scrub('rtsp://admin:pw@10.0.0.1/x') === 'rtsp://***@10.0.0.1/x');
t.check('scrub hides password fields', !scrub('{"password":"hunter2"}').includes('hunter2'));
let threw = false;
try { defineTool({ name: 'Bad-Name', description: 'x'.repeat(30), handler() {} }); } catch { threw = true; }
t.check('defineTool rejects non-snake_case names', threw);

t.section('gate and error mapping (synthetic tools)');
{
  let ran = 0;
  const fake = [
    defineTool({ name: 'fake_reboot', title: 'Fake reboot', description: 'A destructive test tool that only counts calls.',
      inputSchema: { device: z.string().describe('device') }, annotations: { destructiveHint: true }, async handler() { ran += 1; return result(text('rebooted')); } }),
    defineTool({ name: 'fake_write', title: 'Fake write', description: 'A non-destructive write test tool for read-only mode.',
      inputSchema: {}, annotations: { readOnlyHint: false }, async handler() { return result(text('wrote')); } }),
    defineTool({ name: 'fake_fail', title: 'Fake fail', description: 'A read-only test tool that throws a ToolError with a secret.',
      inputSchema: {}, annotations: { readOnlyHint: true }, async handler() { throw new ToolError('BOOM', 'failed for rtsp://u:secret@h/x', 'try password=hunter2'); } }),
  ];
  const run = async (readOnly) => {
    if (readOnly) process.env.MCP_READ_ONLY = '1'; else delete process.env.MCP_READ_ONLY;
    const ctx = createContext({ controllers: [{ name: 'local', url: 'http://127.0.0.1:9' }], devices: [] }, { log() {} });
    delete process.env.MCP_READ_ONLY;
    const server = await createMcpServer(ctx, { tools: fake, prompts: [] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(a);
    return client;
  };
  const c = await run(false);
  const listed = (await c.listTools()).tools;
  const reboot = listed.find((x) => x.name === 'fake_reboot');
  t.check('destructive tools get a confirm input', Boolean(reboot?.inputSchema?.properties?.confirm));
  t.check('annotations reach the client', reboot?.annotations?.destructiveHint === true && reboot?.annotations?.openWorldHint === true);
  const blocked = await c.callTool({ name: 'fake_reboot', arguments: { device: 'x' } });
  t.check('destructive call without confirm is refused', blocked.isError === true && /CONFIRMATION_REQUIRED/.test(blocked.content[0].text) && ran === 0);
  const allowed = await c.callTool({ name: 'fake_reboot', arguments: { device: 'x', confirm: true } });
  t.check('destructive call with confirm runs', !allowed.isError && ran === 1);
  const failed = await c.callTool({ name: 'fake_fail', arguments: {} });
  t.check('ToolError becomes isError with code and hint', failed.isError === true && /^BOOM: /.test(failed.content[0].text) && /Hint:/.test(failed.content[0].text));
  t.check('error text is scrubbed', !/secret|hunter2/.test(failed.content[0].text), failed.content[0].text);
  const ro = await run(true);
  const refused = await ro.callTool({ name: 'fake_write', arguments: {} });
  t.check('read-only mode refuses non-read tools', refused.isError === true && /READ_ONLY/.test(refused.content[0].text));
  const okRead = await ro.callTool({ name: 'fake_fail', arguments: {} });
  t.check('read-only mode still runs read tools', /BOOM/.test(okRead.content[0].text));
}

t.section('against a live controller');
const h = await startHarness();
try {
  const r = await h.call('list_controllers');
  const body = h.json(r);
  t.check('list_controllers reaches the controller', body?.controllers?.[0]?.reachable === true, JSON.stringify(body));
  t.check('list_controllers reports protocols', body?.controllers?.[0]?.protocols?.includes('onvif'));
  const s = await h.ctx.sessions.use('mock-cam', (c, sid, entry) => ({ sid, protocol: entry.session.protocol }));
  t.check('ctx.sessions.use connects a configured device', typeof s.sid === 'string' && s.protocol === 'onvif');
  // Expire the controller session behind the context's back: use() must reconnect once.
  await fetch(`${h.appUrl}/api/session/${s.sid}/disconnect`, { method: 'POST' });
  const again = await h.ctx.sessions.use('mock-cam', (c, sid) => c.targets(sid));
  t.check('an expired controller session reconnects transparently', Array.isArray(again?.targets) && again.targets.length > 0);
} finally {
  await h.close();
}

t.section('profile resolution on a 4-channel recorder');
{
  const r = await startHarness({ mockEnv: { MOCK_CHANNELS: '4' } });
  try {
    const snap = await r.call('get_snapshot', { device: 'mock-cam' });
    t.check('snapshot without a channel defaults to the first stream', !snap.isError && snap.content.some((b) => b.type === 'image'), r.text(snap));
    const ptz = await r.call('ptz_status', { device: 'mock-cam' });
    t.check('PTZ refuses to guess which camera on a recorder', ptz.isError === true && /multiple channels/.test(r.text(ptz)), r.text(ptz));
    const ch3 = await r.call('get_snapshot', { device: 'mock-cam', channel: 3 });
    t.check('a named channel resolves for snapshots', !ch3.isError, r.text(ch3));
    const bad = await r.call('get_snapshot', { device: 'mock-cam', channel: 9 });
    t.check('a channel that does not exist is a clear error', bad.isError === true && /No channel 9/.test(r.text(bad)));
    const badProfile = await r.call('ptz_status', { device: 'mock-cam', profile: 'nope' });
    t.check('an unknown profile token is refused before any device call', badProfile.isError === true && /NOT_FOUND/.test(r.text(badProfile)));
  } finally {
    await r.close();
  }
}

t.section('stdio entry point');
{
  const child = spawn(process.execPath, ['mcp/index.js'], { cwd: ROOT, env: { ...process.env, ONVIF_CONTROLLER_URL: 'http://127.0.0.1:9' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes('"id":2')) await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGTERM');
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  t.check('stdout carries only JSON-RPC', lines.every((m) => m.jsonrpc === '2.0'));
  t.check('stdio server lists tools', lines.find((m) => m.id === 2)?.result?.tools?.some((x) => x.name === 'list_controllers'));
}

t.done();
process.exit(t.failed ? 1 : 0);
