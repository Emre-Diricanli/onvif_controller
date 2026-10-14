/**
 * Device maintenance tools (API.md "Device").
 *
 * These act on the device as a whole rather than a picture setting: correct its
 * clock, drive an alarm relay, or reboot it. reboot_device is the disruptive one
 * and is gated behind confirm by the core; after a reboot the session is torn
 * down on purpose so the next call reconnects cleanly instead of reusing a
 * session the device has already dropped.
 */
import { z } from 'zod';
import { defineTool, result, json } from '../lib/kit.js';

const DEVICE = {
  device: z.string().describe('Device name (from list_devices) or ad-hoc handle (adhoc-N).'),
};

export const tools = [
  defineTool({
    name: 'sync_time',
    title: 'Sync device clock',
    description: 'Sets the device clock from the controller host\'s clock (manual time, UTC). Use it to fix '
      + 'clock skew, which is the usual cause of ONVIF digest-auth "not authorized" failures and wrong '
      + 'timestamps on recordings — device_info reports clockSkewSeconds. Returns ok when the device accepted '
      + 'the write. Changes the device (not read-only) but is not disruptive; nothing restarts. ONVIF sessions '
      + 'only. After syncing, re-check device_info to confirm the skew dropped.',
    inputSchema: { ...DEVICE },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async handler({ device }, ctx) {
      await ctx.sessions.use(device, (client, sid) => client.syncTime(sid));
      return result(json({
        device,
        synced: true,
        detail: 'Device clock set from the controller host (manual, UTC). Re-read device_info to confirm clockSkewSeconds.',
      }));
    },
  }),

  defineTool({
    name: 'reboot_device',
    title: 'Reboot device',
    description: 'Reboots the camera or recorder. DISRUPTIVE and hard to undo once sent: the device goes offline '
      + 'for roughly 1-3 minutes while it restarts, and every live stream, recording, and session on it drops '
      + 'during that time. On a recorder this affects ALL its channels, not one. Requires confirm: true after '
      + 'you have told the user which device will reboot and they agreed. This tool disconnects the session '
      + 'afterwards so the next call reconnects fresh. Wait a few minutes, then use device_info to confirm it '
      + 'is back.',
    inputSchema: { ...DEVICE },
    annotations: { destructiveHint: true, idempotentHint: false },
    async handler({ device }, ctx) {
      const out = await ctx.sessions.use(device, (client, sid) => client.reboot(sid));
      // The device is going down; drop our session now so we never hand a later
      // call a session the reboot has already invalidated. It reconnects on demand.
      await ctx.sessions.disconnect(device).catch(() => {});
      return result(json({
        device,
        rebooting: true,
        message: out?.message ?? 'Reboot command accepted.',
        detail: 'Device is restarting and will be offline ~1-3 minutes; streams and sessions dropped. Session disconnected — the next call reconnects. Re-check with device_info after a few minutes.',
      }));
    },
  }),

  defineTool({
    name: 'set_relay',
    title: 'Set a relay output',
    description: 'Drives a device relay output (alarm-out contact) to "active" or "inactive". Relays switch real '
      + 'physical equipment — gates, doors, sirens, lights — so this is disruptive and requires confirm: true '
      + 'after you have told the user which relay on which device will change and they agreed. Get relay tokens '
      + 'and their current state from device_info (relayOutputs). Returns ok when the device accepted the '
      + 'command. ONVIF sessions with relay outputs only.',
    inputSchema: {
      ...DEVICE,
      token: z.string().describe('Relay output token, from device_info relayOutputs (e.g. "RelayOutput_0").'),
      state: z.enum(['active', 'inactive']).describe('Logical state to drive the relay to: "active" (energize/close) or "inactive" (open/release).'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    async handler({ device, token, state }, ctx) {
      await ctx.sessions.use(device, (client, sid) => client.setRelay(sid, { token, state }));
      return result(json({ device, token, state, ok: true }));
    },
  }),
];
