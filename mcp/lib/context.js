/**
 * The tool context: controllers, configured devices, and device sessions
 * (MCP.md §4, §6).
 *
 * Concurrent callers share a connection; only expired sessions are retried.
 */
import { ControllerClient, ControllerError } from './client.js';
import { ToolError, scrub } from './kit.js';
import { loadConfig, validateConfig, configWarnings, hostAllowed, normalizeHost } from './config.js';

export { loadConfig } from './config.js';

export function createContext(config = loadConfig(), { log = (level, msg) => process.stderr.write(`[mcp ${level}] ${msg}\n`) } = {}) {
  config = validateConfig(config);
  const output = log;
  log = (level, msg) => output(level, scrub(msg));
  for (const warning of configWarnings(config)) log('warn', warning);
  const controllers = new Map();
  for (const c of config.controllers ?? []) {
    controllers.set(c.name, new ControllerClient({ name: c.name, url: c.url, token: c.token ?? null, timeoutMs: c.timeoutMs }));
  }
  const defaultController = config.defaultController ?? config.controllers?.[0]?.name;

  const secrets = new Map();   // device/handle name -> { username, password }; never exposed
  const devices = new Map();
  for (const d of config.devices ?? []) {
    devices.set(d.name, {
      name: d.name, controller: d.controller ?? defaultController, host: d.host,
      port: d.port ?? 80, protocol: d.protocol ?? 'auto', label: d.label ?? null, notes: d.notes ?? null,
    });
    secrets.set(d.name, { username: d.username ?? '', password: d.password ?? '' });
  }

  const live = new Map();      // ref -> { sessionId, session }
  const opening = new Map();
  const disconnecting = new Map();
  let closed = false;
  let closePromise;
  let adhocCounter = 0;

  function assertOpen() {
    if (closed) throw new ToolError('CONTEXT_CLOSED', 'The controller context is closed.');
  }

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

  function open(ref) {
    assertOpen();
    if (disconnecting.has(ref)) throw new ToolError('SESSION_CLOSING', 'The device is disconnecting.');
    if (live.has(ref)) return Promise.resolve(live.get(ref));
    if (opening.has(ref)) return opening.get(ref);
    const device = deviceFor(ref);
    const client = controllerFor(device.controller);
    const creds = secrets.get(ref) ?? {};
    const pending = (async () => {
      const session = await client.connect({ host: device.host, port: device.port, protocol: device.protocol, ...creds });
      if (!session?.sessionId) throw new ControllerError('CONTROLLER_INVALID_RESPONSE', 'Controller returned no session ID.');
      const state = { sessionId: session.sessionId, session };
      live.set(ref, state);
      return state;
    })().finally(() => opening.delete(ref));
    opening.set(ref, pending);
    return pending;
  }

  async function use(ref, fn) {
    assertOpen();
    if (disconnecting.has(ref)) throw new ToolError('SESSION_CLOSING', 'The device is disconnecting.');
    const device = deviceFor(ref);
    const client = controllerFor(device.controller);
    let state = live.get(ref) ?? await open(ref);
    try {
      return await fn(client, state.sessionId, { ref, controller: client.name, device, session: state.session });
    } catch (err) {
      // Only an expired controller session is retried: the request never ran.
      if (!(err instanceof ControllerError) || err.code !== 'SESSION_EXPIRED') throw err;
      if (live.get(ref) === state) live.delete(ref);
      state = await open(ref);
      return fn(client, state.sessionId, { ref, controller: client.name, device, session: state.session });
    }
  }

  async function connect({ controller, host, port = 80, username = '', password = '', protocol = 'auto', label = null }) {
    assertOpen();
    const ctrl = controllerFor(controller);
    const policy = config.controllers.find((c) => c.name === ctrl.name).allowHosts;
    if (!hostAllowed(host, policy)) throw new ToolError('HOST_NOT_ALLOWED', 'The device host is not allowed by this controller configuration.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError('BAD_REQUEST', 'Device port must be an integer from 1 to 65535.');
    host = normalizeHost(host);
    let ref;
    do { ref = `adhoc-${++adhocCounter}`; } while (devices.has(ref));
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
    if (disconnecting.has(ref)) return disconnecting.get(ref);
    const device = deviceFor(ref);
    const pending = (async () => {
      /** Await first-use connects so shutdown cannot orphan a late session. */
      await opening.get(ref)?.catch(() => {});
      const state = live.get(ref);
      live.delete(ref);
      if (state) {
        try { await controllerFor(device.controller).disconnect(state.sessionId); } catch { /* already gone */ }
      }
      if (device.adhoc) { devices.delete(ref); secrets.delete(ref); }
    })().finally(() => disconnecting.delete(ref));
    disconnecting.set(ref, pending);
    return pending;
  }

  function list() {
    return [...devices.values()].map((d) => {
      const state = live.get(d.name);
      return {
        ref: d.name, controller: d.controller, host: d.host, port: d.port, label: d.label,
        adhoc: Boolean(d.adhoc), connected: Boolean(state), protocol: state?.session?.protocol ?? null,
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
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...opening.values()]);
        await Promise.allSettled([...devices.keys()].map((ref) => disconnect(ref)));
        secrets.clear();
      })();
      return closePromise;
    },
  };
}
