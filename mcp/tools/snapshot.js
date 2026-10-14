/**
 * get_snapshot: the agent's eyes. A JPEG from the controller's snapshot proxy
 * (API.md "Media"), returned as an MCP image block so a vision-capable agent
 * can judge exposure, colour, focus and framing before and after a change.
 */
import { z } from 'zod';
import { resolveProfile } from '../lib/profiles.js';
import { defineTool, result, text, image, ToolError } from '../lib/kit.js';
import { ControllerError } from '../lib/client.js';

/** Vendor-only sessions have no media profiles, so nothing to snapshot. */
function pickProfile(session, args) {
  if (!(session?.profiles ?? []).length) {
    throw new ToolError('UNSUPPORTED',
      `This device was reached through its ${session?.protocol ?? 'vendor'} API, which has no snapshot support here.`,
      'Snapshots need an ONVIF session. Use read_settings to inspect it, or reconnect with protocol "onvif" if the device speaks ONVIF.');
  }
  return resolveProfile(session, args, { guessOnMultiChannel: true, preferSnapshot: true });
}

export const tools = [
  defineTool({
    name: 'get_snapshot',
    title: 'Get a camera snapshot',
    description: 'Fetches a current JPEG still from the camera and returns it as an image you can look at, plus a line with '
      + 'device, channel/profile, time and size. Use it to see the scene before tuning and after every picture change '
      + '(write_settings) to verify the effect. Pick a channel (1-based, as in list_targets) or a profile token; omit both '
      + 'for the first stream. Full device resolution, not resized. Read-only. Vendor-only sessions have no snapshots.',
    inputSchema: {
      device: z.string().describe('Device name from list_devices, or a handle returned by connect_device (e.g. "adhoc-1").'),
      channel: z.number().int().min(1).optional().describe('1-based channel number (as in list_targets) on a multi-channel recorder; uses that channel\'s first profile.'),
      profile: z.string().optional().describe('Media profile token (e.g. "Profile_1") to snapshot exactly that stream. Overrides channel.'),
    },
    annotations: { readOnlyHint: true },
    async handler({ device, channel, profile }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        const pick = pickProfile(entry.session, { profile, channel });
        let snap;
        try {
          snap = await client.snapshot(sid, pick.token);
        } catch (err) {
          if (err instanceof ControllerError && err.code === 'UNSUPPORTED') {
            throw new ToolError('UNSUPPORTED', `${device} does not provide snapshots for profile ${pick.token}: ${err.message}`,
              'Try another channel or profile, or inspect the device with read_settings instead.');
          }
          throw err;
        }
        const mimeType = (snap.contentType ?? 'image/jpeg').split(';', 1)[0].trim() || 'image/jpeg';
        if (!snap.buffer?.length) throw new ToolError('DEVICE_ERROR', `${device} returned an empty snapshot.`, 'Try again, or try another profile.');
        const where = pick.channel ? `channel ${pick.channel} (profile ${pick.token})` : `profile ${pick.token}`;
        const kb = (snap.buffer.length / 1024).toFixed(1);
        return result(
          image(snap.buffer, mimeType),
          text(`Snapshot of ${device}, ${where}, taken ${new Date().toISOString()}, ${kb} KB ${mimeType}.`),
        );
      });
    },
  }),
];
