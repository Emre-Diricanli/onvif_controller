#!/usr/bin/env node
/**
 * ONVIF Controller MCP server.
 *
 *   node mcp/index.js                       stdio (Claude Code, Claude Desktop, any MCP client)
 *   node mcp/index.js --http [--port 8770] [--host 127.0.0.1]
 *                                           Streamable HTTP at /mcp
 *
 * Configuration: MCP.md §6 (ONVIF_MCP_CONFIG, default mcp/config.json).
 * stdout belongs to the stdio transport; everything else logs to stderr.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext } from './lib/context.js';
import { createMcpServer, loadTools, loadPrompts } from './server.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const ctx = createContext();
const tools = await loadTools();
const prompts = await loadPrompts();

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function serveHttp() {
  const port = Number(flag('--port', process.env.MCP_HTTP_PORT ?? 8770));
  const host = String(flag('--host', process.env.MCP_HTTP_HOST ?? '127.0.0.1'));
  const token = process.env.MCP_HTTP_TOKEN ?? null;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !token) {
    process.stderr.write('Refusing to bind a non-loopback address without MCP_HTTP_TOKEN (MCP.md §7).\n');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (token && !sameSecret(req.headers.authorization, `Bearer ${token}`)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
      return;
    }
    // Stateless: a fresh MCP server + transport per request. Device sessions
    // live in the shared context, so nothing is lost between requests.
    const mcp = await createMcpServer(ctx, { tools, prompts });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = undefined; }
    }
    await transport.handleRequest(req, res, body);
  });
  server.listen(port, host, () => process.stderr.write(`ONVIF Controller MCP (Streamable HTTP) — http://${host}:${port}/mcp\n`));
}

async function serveStdio() {
  const mcp = await createMcpServer(ctx, { tools, prompts });
  await mcp.connect(new StdioServerTransport());
  process.stderr.write(`ONVIF Controller MCP (stdio): ${tools.length} tools, controllers: ${[...ctx.controllers.keys()].join(', ')}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await ctx.close(); process.exit(0); });
}

if (flag('--http')) await serveHttp();
else await serveStdio();
