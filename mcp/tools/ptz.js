/**
 * PTZ tools (MCP.md §5, API.md "PTZ").
 *
 * All vectors are normalized -1.0..1.0 and map onto the device's real PTZ space
 * in the controller. PTZ is an ONVIF-only surface: a vendor-only session gets a
 * clear UNSUPPORTED rather than a confusing 501. The one safety rule that shapes
 * this module is ptz_move's: a continuous move MUST be followed by a stop, so
 * the stop lives in a finally block and can never be skipped (the browser-less
 * agent has no joystick to release).
 */
import { z } from 'zod';
import { resolveProfile } from '../lib/profiles.js';
import { defineTool, result, json, ToolError } from '../lib/kit.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** PTZ never guesses which camera on a recorder to move (lib/profiles.js). */
const resolvePtzProfile = (session, args) => resolveProfile(session, args).token;

/** Refuse PTZ on a vendor-only session or a device with no movable node. */
function requirePtz(entry) {
  const s = entry.session ?? {};
  if ((s.protocol ?? 'onvif') !== 'onvif') {
    throw new ToolError('UNSUPPORTED', `PTZ needs an ONVIF session; this device is connected through "${s.protocol}".`,
      'Vendor-only sessions expose settings, not PTZ. If the device speaks ONVIF, reconnect it with protocol "onvif" or "auto".');
  }
  if (!s.ptz) {
    throw new ToolError('UNSUPPORTED', 'This device does not support PTZ (no movable PTZ node was found).',
      'device_info reports ptz.supported; a fixed camera cannot pan, tilt, or zoom.');
  }
}

/** Input fields shared by every profile-scoped PTZ tool. */
const TARGET = {
  device: z.string().describe('Device name (from list_devices) or ad-hoc handle (adhoc-N).'),
  profile: z.string().optional()
    .describe('Media profile token from device_info. Required on a multi-channel device unless you pass channel. Omit on a single-channel device to use its first profile.'),
  channel: z.number().int().min(1).optional()
    .describe("Convenience for recorders: 1-based channel number, resolved to that channel's first profile. Ignored when profile is given."),
};

const VECTOR = {
  pan: z.number().min(-1).max(1).optional()
    .describe('Pan velocity/position, -1.0 (left/down) to 1.0 (right/up). Default 0 (no pan).'),
  tilt: z.number().min(-1).max(1).optional()
    .describe('Tilt velocity/position, -1.0 to 1.0. Default 0 (no tilt).'),
  zoom: z.number().min(-1).max(1).optional()
    .describe('Zoom velocity/position, -1.0 (out) to 1.0 (in). Default 0 (no zoom).'),
};

export const tools = [
  defineTool({
    name: 'ptz_move',
    title: 'PTZ continuous move (timed)',
    description: 'Moves the camera continuously at pan/tilt/zoom velocities (-1.0..1.0) for duration_ms '
      + '(100-5000), then ALWAYS stops it — the stop is sent even if the move fails, so the camera is never '
      + 'left panning. Use it for a short, bounded nudge; for a named position use ptz_goto_preset. On a '
      + 'multi-channel device pass profile or channel. Returns the final ptz_status (position, moving) when '
      + 'the device reports it. Physically moves the device (not read-only); the movement stops by itself.',
    inputSchema: {
      ...TARGET,
      ...VECTOR,
      duration_ms: z.number().int().min(100).max(5000)
        .describe('REQUIRED. How long to move before an automatic stop, in milliseconds (100-5000). Keep it short; the camera moves the whole time.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler({ device, profile, channel, pan, tilt, zoom, duration_ms: durationMs }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        const vector = { pan: pan ?? 0, tilt: tilt ?? 0, zoom: zoom ?? 0 };
        let moveError = null;
        try {
          await client.ptzMove(sid, { profile: resolved, ...vector });
          await sleep(durationMs);
        } catch (err) {
          moveError = err;
        } finally {
          // Never leave a camera moving: stop even if the move or the wait threw.
          // Stop is idempotent, and swallowing its error keeps the real move error.
          await client.ptzStop(sid, { profile: resolved }).catch(() => {});
        }
        // A SESSION_EXPIRED from the move propagates so use() can reconnect and
        // retry before anything physically moved; every later error is contained.
        if (moveError) throw moveError;
        let status = null;
        try { status = await client.ptzStatus(sid, resolved); } catch { /* status is a bonus, not the point */ }
        return result(json({ device, profile: resolved, moved: vector, duration_ms: durationMs, stopped: true, status }));
      });
    },
  }),

  defineTool({
    name: 'ptz_stop',
    title: 'PTZ stop',
    description: 'Stops all PTZ motion on a profile immediately. Idempotent and safe to call even when nothing '
      + 'is moving — it never fails for that. Use it as the safety stop after any movement, or if a move seems '
      + 'stuck. ptz_move already stops itself, so this is for manual/relative moves or emergencies. On a '
      + 'multi-channel device pass profile or channel. Physically stops the device (not read-only).',
    inputSchema: {
      ...TARGET,
      panTilt: z.boolean().optional().describe('Stop pan/tilt motion. Default true.'),
      zoom: z.boolean().optional().describe('Stop zoom motion. Default true.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async handler({ device, profile, channel, panTilt, zoom }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        await client.ptzStop(sid, { profile: resolved, panTilt: panTilt ?? true, zoom: zoom ?? true });
        return result(json({ device, profile: resolved, stopped: true, panTilt: panTilt ?? true, zoom: zoom ?? true }));
      });
    },
  }),

  defineTool({
    name: 'ptz_status',
    title: 'PTZ status',
    description: 'Reads the current PTZ state of a profile: normalized position (pan, tilt, zoom in -1.0..1.0), '
      + 'whether the camera is currently moving, and the device UTC time of the reading. Use it to confirm a '
      + 'move finished, to check the camera is idle, or before saving a preset. Read-only; nothing moves. On a '
      + 'multi-channel device pass profile or channel.',
    inputSchema: { ...TARGET },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device, profile, channel }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        const status = await client.ptzStatus(sid, resolved);
        return result(json({ device, profile: resolved, ...(status ?? {}) }));
      });
    },
  }),

  defineTool({
    name: 'ptz_go_home',
    title: 'PTZ go to / set home',
    description: 'Moves the camera to its saved home position (action "goto", the default), or records the '
      + 'current position as home (action "set"). Home support varies; device_info reports ptz.homeSupported. '
      + 'Use "goto" to return a PTZ to a known overview, "set" to define that overview first. On a '
      + 'multi-channel device pass profile or channel. Physically moves the device (not read-only); "set" '
      + 'overwrites the stored home.',
    inputSchema: {
      ...TARGET,
      action: z.enum(['goto', 'set']).optional()
        .describe('"goto" (default) moves to the stored home position; "set" saves the current position as home.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler({ device, profile, channel, action }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        const act = action ?? 'goto';
        await client.ptzHome(sid, { profile: resolved, action: act });
        return result(json({ device, profile: resolved, action: act, ok: true }));
      });
    },
  }),

  defineTool({
    name: 'ptz_list_presets',
    title: 'List PTZ presets',
    description: 'Lists the saved PTZ presets on a profile: each with its token, name, and stored position '
      + '(when the device reports one). Use it before ptz_goto_preset (to get a token or exact name) or '
      + 'ptz_delete_preset. Read-only; nothing moves. On a multi-channel device pass profile or channel.',
    inputSchema: { ...TARGET },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device, profile, channel }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        const found = await client.ptzPresets(sid, resolved);
        const presets = Array.isArray(found?.presets) ? found.presets : [];
        return result(json({ device, profile: resolved, count: presets.length, presets }));
      });
    },
  }),

  defineTool({
    name: 'ptz_goto_preset',
    title: 'PTZ go to preset',
    description: 'Moves the camera to a saved preset, given either its token or its name (name matching is '
      + 'case-insensitive). Call ptz_list_presets first to see tokens and names. Optionally set speed '
      + '(0.0-1.0). On a multi-channel device pass profile or channel. Physically moves the device '
      + '(not read-only); motion ends at the preset. An unknown name is NOT_FOUND listing the real names.',
    inputSchema: {
      ...TARGET,
      token: z.string().optional().describe('Preset token from ptz_list_presets. Preferred; used as-is when given.'),
      name: z.string().optional().describe('Preset name, matched case-insensitively and resolved to its token. Used only when token is omitted.'),
      speed: z.number().min(0).max(1).optional().describe('Movement speed 0.0-1.0. Omit for the device default.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async handler({ device, profile, channel, token, name, speed }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        let presetToken = typeof token === 'string' && token.trim() ? token.trim() : null;
        let matchedName = null;
        if (!presetToken) {
          if (typeof name !== 'string' || !name.trim()) {
            throw new ToolError('BAD_REQUEST', 'Pass a preset token or name.',
              'Call ptz_list_presets to see the available presets.');
          }
          const found = await client.ptzPresets(sid, resolved);
          const presets = Array.isArray(found?.presets) ? found.presets : [];
          const want = name.trim().toLowerCase();
          const hit = presets.find((p) => String(p?.name ?? '').toLowerCase() === want);
          if (!hit) {
            throw new ToolError('NOT_FOUND', `No preset named "${name.trim()}".`,
              `Available: ${presets.map((p) => p.name).join(', ') || '(none)'}`);
          }
          presetToken = String(hit.token);
          matchedName = hit.name ?? name.trim();
        }
        await client.ptzGotoPreset(sid, { profile: resolved, token: presetToken, speed });
        return result(json({ device, profile: resolved, token: presetToken, name: matchedName, moved: true }));
      });
    },
  }),

  defineTool({
    name: 'ptz_save_preset',
    title: 'Save a PTZ preset',
    description: 'Saves the camera\'s CURRENT position as a preset with the given name. Pass an existing token '
      + 'to overwrite that preset; omit it to create a new one. Returns the token and name the device assigned. '
      + 'Move the camera first (ptz_move/ptz_goto_preset) or it saves wherever it currently points. On a '
      + 'multi-channel device pass profile or channel. Changes device state but is not destructive (nothing is '
      + 'lost; a created preset can be deleted).',
    inputSchema: {
      ...TARGET,
      name: z.string().min(1).describe('Name for the preset (up to 64 characters).'),
      token: z.string().optional().describe('Existing preset token to overwrite. Omit to create a new preset.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler({ device, profile, channel, name, token }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        const saved = await client.ptzSavePreset(sid, { profile: resolved, name, token });
        return result(json({ device, profile: resolved, token: saved?.token ?? token ?? null, name: saved?.name ?? name, saved: true }));
      });
    },
  }),

  defineTool({
    name: 'ptz_delete_preset',
    title: 'Delete a PTZ preset',
    description: 'Deletes a saved PTZ preset by token. This is disruptive and hard to undo — the stored position '
      + 'is lost — so it requires confirm: true after you have told the user which preset on which device will '
      + 'be removed and they agreed. Call ptz_list_presets first to get the exact token and show its name to the '
      + 'user. On a multi-channel device pass profile or channel.',
    inputSchema: {
      ...TARGET,
      token: z.string().describe('Preset token to delete, from ptz_list_presets.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    async handler({ device, profile, channel, token }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        requirePtz(entry);
        const resolved = resolvePtzProfile(entry.session, { profile, channel });
        await client.ptzDeletePreset(sid, resolved, token);
        return result(json({ device, profile: resolved, token, deleted: true }));
      });
    },
  }),
];
