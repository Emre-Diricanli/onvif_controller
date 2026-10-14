/**
 * Device discovery and session tools (MCP.md §4).
 *
 * These are the agent's way in: see what is configured, find what is on the
 * network, open an ad-hoc device by address, and read what a device actually
 * is. Credentials are held in the context (memory only) and are never echoed
 * back into a result, a log line, or an error — see the invariants in MCP.md §9.
 */
import { z } from 'zod';
import { defineTool, result, json, ToolError } from '../lib/kit.js';

/** A compact, credential-free view of a live session's capabilities. */
function capabilitySummary(capabilities) {
  const c = capabilities ?? {};
  return {
    media: Boolean(c.media),
    media2: Boolean(c.media2),
    ptz: Boolean(c.ptz),
    imaging: Boolean(c.imaging),
    events: Boolean(c.events),
    analytics: Boolean(c.analytics),
    recording: Boolean(c.recording),
    deviceIO: Boolean(c.deviceIO),
    audioBackchannel: Boolean(c.audioBackchannel),
    relayOutputs: Number(c.relayOutputs ?? 0),
    settings: Boolean(c.settings ?? true),
  };
}

/** Flatten a session profile into the codec/resolution/fps summary agents read. */
function profileSummary(profile) {
  const v = profile?.video ?? {};
  const resolution = v.width && v.height ? `${v.width}x${v.height}` : null;
  return {
    token: profile?.token ?? null,
    name: profile?.name ?? null,
    codec: v.codec ?? null,
    resolution,
    fps: v.fps ?? null,
    bitrate: v.bitrate ?? null,
    ptzSupported: Boolean(profile?.ptzSupported),
    snapshotSupported: Boolean(profile?.snapshotSupported),
  };
}

export const tools = [
  defineTool({
    name: 'list_devices',
    title: 'List devices',
    description: 'Lists every device this server can act on: the configured devices (with their label and '
      + 'site notes) plus any ad-hoc handles opened by connect_device. For each it reports name, controller, '
      + 'host, port, whether a session is currently connected, and — once connected — the negotiated protocol '
      + 'and model. Call this first to learn the `device` reference every other tool needs. Read-only; no '
      + 'device is contacted. Credentials are never included.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(_args, ctx) {
      // ctx.sessions.list() is authoritative for live state (connected, protocol,
      // model) and already covers configured devices and ad-hoc handles; enrich
      // each row with the human label/notes kept in the device registry.
      const rows = ctx.sessions.list().map((s) => {
        const dev = ctx.devices.get(s.ref);
        return {
          name: s.ref,
          label: dev?.label ?? s.label ?? null,
          notes: dev?.notes ?? null,
          controller: s.controller,
          host: s.host,
          port: s.port,
          connected: Boolean(s.connected),
          protocol: s.protocol ?? null,
          model: s.model ?? null,
          adhoc: Boolean(dev?.adhoc),
        };
      });
      return result(json({ readOnly: ctx.readOnly, count: rows.length, devices: rows }));
    },
  }),

  defineTool({
    name: 'discover_devices',
    title: 'Discover devices (WS-Discovery)',
    description: 'Runs a WS-Discovery multicast probe through a controller and returns the ONVIF devices that '
      + 'answer (host, port, name, hardware, service addresses). Use it to find a camera\'s address before '
      + 'connect_device. Returns { devices: [...] }, which may be EMPTY: discovery does not work from inside '
      + 'a Docker container and is often blocked across VLANs/Wi-Fi, so an empty list is not an error. '
      + 'Read-only; nothing is connected. If it finds nothing, connect by known address instead.',
    inputSchema: {
      controller: z.string().optional()
        .describe('Controller name (from list_controllers) to probe from. Omit for the default. Discovery sees only that controller\'s network.'),
      timeout_ms: z.number().int().min(1000).max(15000).optional()
        .describe('How long to wait for multicast replies, in milliseconds (1000-15000). Default 5000. Longer finds slower/quieter subnets.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ controller, timeout_ms: timeoutMs }, ctx) {
      const client = ctx.controllerFor(controller);
      const found = await client.discover(timeoutMs ?? 5000);
      const devices = (found?.devices ?? []).map((d) => ({
        host: d.host ?? null,
        port: d.port ?? 80,
        name: d.name ?? null,
        hardware: d.hardware ?? null,
        xaddrs: Array.isArray(d.xaddrs) ? d.xaddrs : [],
      }));
      return result(json({
        controller: client.name,
        count: devices.length,
        devices,
        // Set the expectation honestly: an empty probe is normal, not a failure.
        note: devices.length === 0
          ? 'No devices answered. WS-Discovery is blocked inside Docker and across some networks; connect_device by address instead.'
          : undefined,
      }));
    },
  }),

  defineTool({
    name: 'connect_device',
    title: 'Connect to a device by address',
    description: 'Opens an ad-hoc session to a device you address directly, and returns a handle (adhoc-1, '
      + 'adhoc-2, …) to pass as `device` to every other tool. Use it for a camera that is not in the config '
      + '(find addresses with discover_devices). Returns the handle, negotiated protocol, model, a capability '
      + 'summary, profile/target counts. Credentials are kept in memory for the life of the session only and '
      + 'are NEVER returned or logged. This creates a live session (not read-only) but changes nothing on the '
      + 'device. Call disconnect_device when done.',
    inputSchema: {
      host: z.string().describe('Camera/recorder IP address or hostname. Just the host — no scheme, path, or credentials.'),
      port: z.number().int().min(1).max(65535).optional()
        .describe('TCP port of the device service. Default 80 (ONVIF). Vendor APIs may use another port.'),
      username: z.string().describe('Device username. For Hikvision this must be an ONVIF-enabled user, not necessarily the web admin.'),
      password: z.string().describe('Device password. Held in memory only; never returned, logged, or echoed in errors.'),
      protocol: z.string().optional()
        .describe("How to reach the device: 'auto' (default; ONVIF then vendor probe), 'onvif', or an adapter id from list_controllers (hikvision, dahua, axis, reolink, uniview)."),
      controller: z.string().optional()
        .describe('Controller name (from list_controllers) to connect through. Omit for the default. Use a controller that can reach this host.'),
    },
    // Not read-only (it creates a session) but not destructive; a second call
    // makes a second independent handle, so it is deliberately not idempotent.
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler({ host, port, username, password, protocol, controller }, ctx) {
      const { ref, session } = await ctx.sessions.connect({
        controller, host, port: port ?? 80, username, password, protocol: protocol ?? 'auto',
      });
      // Targets are a bonus count for the agent; never fail a good connect over
      // a settings-surface hiccup, so this is best effort.
      let targets = null;
      try {
        targets = await ctx.sessions.use(ref, (client, sid) => client.targets(sid));
      } catch { /* a device without the settings surface still connected fine */ }
      const profiles = Array.isArray(session?.profiles) ? session.profiles : [];
      return result(json({
        ref,
        protocol: session?.protocol ?? null,
        manufacturer: session?.device?.manufacturer ?? null,
        model: session?.device?.model ?? null,
        firmware: session?.device?.firmware ?? null,
        capabilities: capabilitySummary(session?.capabilities),
        isMultiChannel: Boolean(session?.isMultiChannel),
        profiles: profiles.length,
        targets: Array.isArray(targets?.targets) ? targets.targets.length : null,
        credentials: 'Held in memory for this session only; never returned or logged.',
        next: `Pass device: "${ref}" to other tools. Call disconnect_device("${ref}") when finished.`,
      }));
    },
  }),

  defineTool({
    name: 'disconnect_device',
    title: 'Disconnect a device',
    description: 'Ends the session for a device. For a configured device it just drops the live session (the '
      + 'device stays listed and reconnects on next use). For an ad-hoc handle from connect_device it also '
      + 'forgets the handle and its in-memory credentials, so the ref stops working. Use it to release a '
      + 'device, clear credentials, or force a fresh reconnect. Not read-only, but changes nothing on the '
      + 'device itself. Safe to call after reboot_device.',
    inputSchema: {
      device: z.string().describe('Device name (from list_devices) or ad-hoc handle (adhoc-N) to disconnect.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler({ device }, ctx) {
      // Confirm the ref exists first so the agent gets a clear UNKNOWN_DEVICE
      // rather than a silent no-op when it mistypes a handle.
      if (!ctx.devices.has(device)) {
        throw new ToolError('UNKNOWN_DEVICE', `No device or handle "${device}".`,
          'Use list_devices for current names and handles.');
      }
      const wasAdhoc = Boolean(ctx.devices.get(device)?.adhoc);
      await ctx.sessions.disconnect(device);
      return result(json({
        device,
        disconnected: true,
        forgotten: wasAdhoc,
        detail: wasAdhoc
          ? 'Ad-hoc handle forgotten; its in-memory credentials are cleared.'
          : 'Session closed. The configured device remains and reconnects on next use.',
      }));
    },
  }),

  defineTool({
    name: 'device_info',
    title: 'Inspect a device',
    description: 'Reads what a device is: manufacturer, model, firmware, serial; the negotiated protocol; the '
      + 'capability matrix; every media profile/stream (codec, resolution, fps, bitrate, PTZ support); whether '
      + 'it is multi-channel; clock skew in seconds; and PTZ capability. For ONVIF sessions it also merges the '
      + 'live device endpoint (network, relay outputs, current clock). Use it before changing anything to '
      + 'learn profile tokens and capabilities. Read-only. Vendor-only sessions have no ONVIF device endpoint, '
      + 'so it returns session info with a note.',
    inputSchema: {
      device: z.string().describe('Device name (from list_devices) or ad-hoc handle (adhoc-N) to inspect.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        const s = entry.session ?? {};
        const caps = s.capabilities ?? {};
        const profiles = (Array.isArray(s.profiles) ? s.profiles : []).map(profileSummary);
        const sources = (Array.isArray(s.sources) ? s.sources : []).map((src) => ({
          token: src?.token ?? null,
          label: src?.label ?? null,
          profiles: Array.isArray(src?.profiles) ? src.profiles.length : 0,
          ptzSupported: Boolean(src?.ptzSupported),
        }));
        const ptz = s.ptz
          ? {
              supported: true,
              presetsSupported: Boolean(s.ptz.presetsSupported),
              homeSupported: Boolean(s.ptz.homeSupported),
              spaces: s.ptz.spaces ?? null,
              auxCommands: Array.isArray(s.ptz.auxCommands) ? s.ptz.auxCommands.length : 0,
            }
          : { supported: false };

        const info = {
          ref: entry.ref,
          controller: entry.controller,
          host: entry.device?.host ?? null,
          port: entry.device?.port ?? null,
          protocol: s.protocol ?? 'onvif',
          device: {
            manufacturer: s.device?.manufacturer ?? null,
            model: s.device?.model ?? null,
            firmware: s.device?.firmware ?? null,
            serial: s.device?.serial ?? null,
            hardwareId: s.device?.hardwareId ?? null,
          },
          // Skew at connect time is always available; the live read below refines it.
          clockSkewSeconds: s.device?.clockSkewSeconds ?? null,
          capabilities: capabilitySummary(caps),
          isMultiChannel: Boolean(s.isMultiChannel),
          profiles,
          sources,
          ptz,
        };

        // The /device endpoint is ONVIF-only (API.md): a vendor-only session
        // answers 501 there, so say so plainly and return the session info.
        if ((s.protocol ?? 'onvif') !== 'onvif') {
          info.note = `The live device endpoint is ONVIF-only; this session uses "${s.protocol}". `
            + 'Returning session info. Use the settings tools (list_targets/read_settings) for this device.';
          return result(json(info));
        }

        try {
          const d = await client.device(sid);
          if (d?.info) {
            info.device = {
              manufacturer: d.info.manufacturer ?? info.device.manufacturer,
              model: d.info.model ?? info.device.model,
              firmware: d.info.firmware ?? info.device.firmware,
              serial: d.info.serial ?? info.device.serial,
              hardwareId: d.info.hardwareId ?? info.device.hardwareId,
            };
          }
          if (d?.time) {
            info.time = {
              deviceTime: d.time.deviceTime ?? null,
              localTime: d.time.localTime ?? null,
              timezone: d.time.timezone ?? null,
              ntpEnabled: Boolean(d.time.ntpEnabled),
            };
            if (typeof d.time.skewSeconds === 'number') info.clockSkewSeconds = d.time.skewSeconds;
          }
          if (d?.network) info.network = d.network;
          if (Array.isArray(d?.relayOutputs)) info.relayOutputs = d.relayOutputs;
        } catch (err) {
          // A failed live read must not lose the whole picture; report why and
          // keep the session-derived info.
          info.deviceEndpointError = err?.code ?? 'DEVICE_ERROR';
        }
        return result(json(info));
      });
    },
  }),
];
