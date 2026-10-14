/**
 * Core tools: what the agent can reach before touching any device.
 * Also the worked example for MCP.md §3 — other tool modules follow this shape.
 */
import { z } from 'zod';
import { defineTool, result, json } from '../lib/kit.js';

export const tools = [
  defineTool({
    name: 'list_controllers',
    title: 'List controllers',
    description: 'Lists the ONVIF Controller instances this server can use (local and remote), whether each is '
      + 'reachable right now, and which device protocols each speaks (onvif, hikvision, dahua, axis, reolink, uniview). '
      + 'Call this first when a device or controller seems unreachable. Read-only; no device is contacted.',
    inputSchema: {
      controller: z.string().optional().describe('Only check this controller (name from the config). Omit for all.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ controller }, ctx) {
      const names = controller ? [ctx.controllerFor(controller).name] : [...ctx.controllers.keys()];
      const rows = await Promise.all(names.map(async (name) => {
        const client = ctx.controllers.get(name);
        try {
          const [health, adapters] = await Promise.all([client.health(), client.adapters()]);
          return {
            name, url: client.base, default: name === ctx.defaultController, reachable: true,
            ffmpeg: health?.ffmpeg ?? null, protocols: (adapters?.adapters ?? []).map((a) => a.id),
          };
        } catch (err) {
          return { name, url: client.base, default: name === ctx.defaultController, reachable: false, error: err.code ?? 'UNREACHABLE' };
        }
      }));
      return result(json({ readOnly: ctx.readOnly, controllers: rows }));
    },
  }),
];
