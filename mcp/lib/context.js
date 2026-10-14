/**
 * The tool context: controllers, configured devices, and device sessions
 * (MCP.md §4, §6).
 *
 * Step-0 reference implementation. The exported interface is frozen; Stream 2
 * owns hardening (config validation, host allowlists, session health checks,
 * concurrency on first connect).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControllerClient, ControllerError } from './client.js';
import { ToolError } from './kit.js';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** "env:NAME" -> process.env.NAME; anything else unchanged. */
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) return process.env[value.slice(4)] ?? null;
  return value;
}

export function loadConfig(file = process.env.ONVIF_MCP_CONFIG ?? path.join(MCP_DIR, 'config.json')) {
  if (!existsSync(file)) {
    return {
      controllers: [{ name: 'local', url: process.env.ONVIF_CONTROLLER_URL ?? 'http://127.0.0.1:8080' }],
      devices: [],
      defaultController: 'local',
    };
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function createContext(config = loadConfig(), { log = (level, msg) => process.stderr.write(`[mcp ${level}] ${msg}\n`) } = {}) {
  const controllers = new Map();
  for (const c of config.controllers ?? []) {
    controllers.set(c.name, new ControllerClient({ name: c.name, url: resolveSecret(c.url), token: resolveSecret(c.token) ?? null, timeoutMs: c.timeoutMs }));
  }
  const defaultController = config.defaultController ?? config.controllers?.[0]?.name;

  const secrets = new Map();   // device/handle name -> { username, password }; never exposed
  const devices = new Map();
  for (const d of config.devices ?? []) {
    devices.set(d.name, {
      name: d.name, controller: d.controller ?? defaultController, host: d.host,
      port: d.port ?? 80, protocol: d.protocol ?? 'auto', label: d.label ?? null, notes: d.notes ?? null,
    });
    secrets.set(d.name, { username: resolveSecret(d.username) ?? '', password: resolveSecret(d.password) ?? '' });
  }

  const live = new Map();      // ref -> { sessionId, session }
  let adhocCounter = 0;

  function controllerFor(name) {
    const client = controllers.get(name ?? defaultController);
    if (!client) throw new ToolError('UNKNOWN_CONTROLLER', `No controller named "${name}".`, `Known: ${[...controllers.keys()].join(', ')}`);
    return client;
  }

  function deviceFor(ref) {
    const device = devices.get(ref);
    if (!device) {
      throw new ToolError('UNKNOWN_DEVICE', `No device "${ref}".`,
        `Use list_devices for configured devices, or connect_device to open one by address. Known: ${[...devices.keys()].join(', ') || '(none)'}`);
    }
    return device;
  }

  async function open(ref) {
    const device = deviceFor(ref);
    const client = controllerFor(device.controller);
    const creds = secrets.get(ref) ?? {};
    const session = await client.connect({ host: device.host, port: device.port, protocol: device.protocol, ...creds });
    live.set(ref, { sessionId: session.sessionId, session });
    return live.get(ref);
  }

  async function use(ref, fn) {
    const device = deviceFor(ref);
    const client = controllerFor(device.controller);
    let state = live.get(ref) ?? await open(ref);
    try {
      return await fn(client, state.sessionId, { ref, controller: client.name, device, session: state.session });
    } catch (err) {
      // Only an expired controller session is retried: the request never ran.
      if (!(err instanceof ControllerError) || err.code !== 'SESSION_EXPIRED') throw err;
      live.delete(ref);
      state = await open(ref);
      return fn(client, state.sessionId, { ref, controller: client.name, device, session: state.session });
    }
  }

  async function connect({ controller, host, port = 80, username = '', password = '', protocol = 'auto', label = null }) {
    const ref = `adhoc-${++adhocCounter}`;
    const ctrl = controllerFor(controller);
    devices.set(ref, { name: ref, controller: ctrl.name, host, port, protocol, label, notes: null, adhoc: true });
    secrets.set(ref, { username, password });
    try {
      const state = await open(ref);
      return { ref, session: state.session };
    } catch (err) {
      devices.delete(ref);
      secrets.delete(ref);
      throw err;
    }
  }

  async function disconnect(ref) {
    const device = deviceFor(ref);
    const state = live.get(ref);
    live.delete(ref);
    if (state) {
      try { await controllerFor(device.controller).disconnect(state.sessionId); } catch { /* already gone */ }
    }
    if (device.adhoc) { devices.delete(ref); secrets.delete(ref); }
  }

  function list() {
    return [...devices.values()].map((d) => {
      const state = live.get(d.name);
      return {
        ref: d.name, controller: d.controller, host: d.host, port: d.port, label: d.label,
        connected: Boolean(state), protocol: state?.session?.protocol ?? null,
        model: state?.session?.device?.model ?? null,
      };
    });
  }

  return {
    controllers,
    devices,
    defaultController,
    readOnly: process.env.MCP_READ_ONLY === '1',
    controllerFor,
    sessions: { use, connect, disconnect, list },
    log,
    async close() {
      for (const ref of [...live.keys()]) await disconnect(ref).catch(() => {});
    },
  };
}
