/**
 * Builds the MCP server: discovers tool modules, applies the confirmation gate
 * and read-only mode, and maps errors (MCP.md §3). Transport-agnostic, so the
 * stdio entry point, the HTTP entry point and the tests all share it.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorResult, ToolError } from './lib/kit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.1.0';

async function importAll(dir, exportName) {
  const out = [];
  let files = [];
  try { files = readdirSync(path.join(HERE, dir)).filter((f) => f.endsWith('.js')).sort(); } catch { return out; }
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(HERE, dir, file)).href);
    for (const item of mod[exportName] ?? []) out.push({ ...item, module: `${dir}/${file}` });
  }
  return out;
}

export async function loadTools() {
  const tools = await importAll('tools', 'tools');
  const seen = new Map();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool "${t.name}" in ${t.module} and ${seen.get(t.name)}`);
    seen.set(t.name, t.module);
  }
  return tools;
}

export async function loadPrompts() {
  return importAll('prompts', 'prompts');
}

const CONFIRM = z.boolean().optional()
  .describe('Set to true ONLY after you have told the user exactly what this will do and they agreed. Without it, nothing happens.');

/** Wrap a handler with read-only enforcement, the confirm gate and error mapping. */
function guarded(def, ctx) {
  const destructive = def.annotations.destructiveHint === true;
  const readOnly = def.annotations.readOnlyHint === true;
  return async (args = {}) => {
    try {
      if (ctx.readOnly && !readOnly) {
        throw new ToolError('READ_ONLY', `${def.name} changes the device, and this server is in read-only mode (MCP_READ_ONLY=1).`);
      }
      if (destructive && args.confirm !== true) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `CONFIRMATION_REQUIRED: ${def.name} is disruptive or hard to undo. Tell the user exactly what it will do `
              + 'to which device, get their explicit approval, then call it again with confirm: true.',
          }],
        };
      }
      const { confirm, ...rest } = args;
      ctx.log('info', `tool ${def.name}`);
      return await def.handler(rest, ctx);
    } catch (err) {
      ctx.log('warn', `tool ${def.name} failed: ${err?.code ?? ''} ${err?.message ?? err}`);
      return errorResult(err);
    }
  };
}

export async function createMcpServer(ctx, { tools, prompts } = {}) {
  const server = new McpServer(
    { name: 'onvif-controller', version: VERSION },
    {
      instructions: 'Tools to inspect and adjust IP cameras and NVR/DVRs through ONVIF Controller instances. '
        + 'Start with list_devices (or connect_device for an address), then list_targets, describe_settings, '
        + 'read_settings and get_snapshot before changing anything. Writes report what the device actually did '
        + '(applied, adjusted, unchanged, rejected, unknown) — check it, and look at a snapshot after picture changes. '
        + 'Disruptive actions need confirm: true after the user has agreed.',
    },
  );
  for (const def of tools ?? await loadTools()) {
    const inputSchema = def.annotations.destructiveHint ? { ...def.inputSchema, confirm: CONFIRM } : def.inputSchema;
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema,
      annotations: { title: def.title, ...def.annotations },
    }, guarded(def, ctx));
  }
  for (const p of prompts ?? await loadPrompts()) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, (args) => p.build(args, ctx));
  }
  return server;
}
