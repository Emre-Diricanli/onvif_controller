# MCP server: the contract

`mcp/` is a Model Context Protocol server that lets an AI agent be pointed at a
camera or recorder and inspect and adjust it with real tools. It works through
one or more running ONVIF Controller instances, local or remote, so every
protocol the controller speaks (ONVIF, Hikvision ISAPI, Dahua/Lorex, Axis,
Reolink, Uniview: ADAPTERS.md) is available to the agent with no new device
code.

**This file is frozen.** Four work streams build against it in parallel. If
you need it to change, say so in your commit message; do not edit it.

---

## 1. Architecture

```
agent (Claude Code, Claude Desktop, any MCP client)
   │  stdio, or Streamable HTTP at /mcp
   ▼
mcp/index.js ── tools/*.js ── ctx.sessions.use(device, fn)
   │                              │
   │                       mcp/lib/context.js   (config, device registry, session cache)
   │                              │
   ▼                       mcp/lib/client.js    (ControllerClient: the REST API in API.md)
ONVIF Controller(s)  ◀── HTTP ──┘   local http://127.0.0.1:8080 and/or remote https://…
   │
   ▼
cameras / NVRs
```

- **The MCP server is a client of the controller's REST API (API.md).** It
  never imports `server/**`. That is what makes remote controllers work: the
  same code path serves a controller on this laptop and one on a site box.
- `mcp/` is its own npm package (`mcp/package.json`). The controller app keeps
  its zero-dependency rule, and the Docker image is unchanged.
- Device sessions are process-global, keyed by device reference, and shared
  across every MCP client connection.

## 2. Ownership

| Stream | Owns (exclusive) |
| --- | --- |
| 1 Core (Claude) | `MCP.md`, `mcp/package.json`, `mcp/index.js`, `mcp/server.js`, `mcp/lib/kit.js`, `mcp/tools/core.js`, `mcp/test/harness.mjs`, `mcp/README.md`, `mcp/config.example.json`, root `README.md`, `.mcp.json`, `tools/tests/mcp-core*.mjs` |
| 2 Client, sessions, auth (Codex) | `mcp/lib/client.js`, `mcp/lib/context.js`, `mcp/lib/config.js`, `server/auth.js`, the auth wiring lines in `server/index.js` and `server/config.js`, `API.md` (auth section only), `tools/tests/mcp-client*.mjs`, `tools/tests/auth*.mjs` |
| 3 Settings, snapshot, prompts (Kimi) | `mcp/tools/settings.js`, `mcp/tools/snapshot.js`, `mcp/prompts/**`, `tools/tests/mcp-settings*.mjs` |
| 4 Devices, PTZ, maintenance (Qwen) | `mcp/tools/devices.js`, `mcp/tools/ptz.js`, `mcp/tools/maintenance.js`, `tools/tests/mcp-devices*.mjs` |

Do not edit a file you do not own. If you need a change in someone else's
file, say so in your commit message. `mcp/lib/client.js` and
`mcp/lib/context.js` ship as Step-0 reference implementations. Their
**exported interface below is frozen**; Stream 2 owns hardening them.

## 3. Tool modules

Every file in `mcp/tools/*.js` exports `tools`, an array of definitions. The
core discovers and registers them, so adding a tool never means editing a
shared file. Tool names are `snake_case`, unique across all modules.

```js
import { z } from 'zod';
import { defineTool, result, json, text, image, ToolError } from '../lib/kit.js';

export const tools = [
  defineTool({
    name: 'read_settings',
    title: 'Read device settings',
    description: '…what it does, when to use it, what it returns, what to call before/after…',
    inputSchema: { device: z.string().describe('…'), target: z.string().describe('…') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const values = await ctx.sessions.use(args.device, (c, sid) => c.readSettings(sid, args.target));
      return result(json(values));
    },
  }),
];
```

- `inputSchema` is a **zod raw shape** (an object of zod types), not a
  `z.object`. Every field gets `.describe()`.
- `annotations` must be honest:
  - `readOnlyHint: true` for anything that does not change a device.
  - `destructiveHint: true` for actions that are disruptive or hard to undo:
    reboot, network changes, codec/resolution changes that restart streams,
    deleting presets.
  - `idempotentHint` where it is true.
  - `openWorldHint: true` everywhere, since every tool talks to real devices.
- **Confirmation gate (enforced by the core, not by tools).** A tool with
  `destructiveHint: true` automatically gets an optional `confirm: boolean`
  input. Called without `confirm: true`, the core does not run the handler. It
  returns an error result telling the agent to describe the action to the
  user, get approval, and call again with `confirm: true`. Handlers never
  re-check this.
- **Read-only mode.** With `MCP_READ_ONLY=1`, the core refuses every tool that
  is not `readOnlyHint: true`.
- Handlers return `result(...blocks)`. Blocks are `text(s)`, `json(obj)`
  (pretty JSON as text), and `image(buffer, mimeType)`. An image block is how
  the agent *sees* the camera.
- Errors: throw `ToolError(code, message, hint?)`, or let a `ControllerError`
  propagate. The core turns both into `{ isError: true }` results carrying
  the code, the message and the hint. Never return a stack trace. Never echo a
  password, a token, or a credentialed RTSP URL.

### Tool-description standard

The description is the agent's manual. Each one states, in this order:
1. what the tool does
2. when to use it, and what to call first (e.g. "call `describe_settings`
   first to learn keys, ranges and units")
3. what it returns, including units and meaning, e.g. outcome values
   `applied | adjusted | unchanged | rejected | unknown`
4. side effects and safety notes

Keep it under ~120 words. No marketing.

## 4. Device references and sessions

A tool that acts on a device takes `device: string`, which is either:
- the **name of a device in the config** (`"lobby-cam"`), whose credentials
  come from config and env and are never shown to the agent, or
- a **handle returned by `connect_device`** for an ad-hoc device
  (`"adhoc-1"`).

```js
ctx.sessions.use(deviceRef, async (client, sessionId, entry) => …)
```

`use` connects on first use, caches the controller session id, and on a
`SESSION_EXPIRED` from the controller reconnects once and retries `fn`. It
never retries a write after any other error (ADAPTERS.md §6: no double
writes). `entry` is `{ ref, controller, device, session }`, where `session`
is the controller's serialized session (`protocol`, `device`, `capabilities`,
`profiles`, `sources`, …).

Other context members (frozen):

| member | shape |
| --- | --- |
| `ctx.controllers` | `Map<name, ControllerClient>` |
| `ctx.devices` | `Map<name, { name, controller, host, port, protocol, label?, notes? }>`, with **no credentials** |
| `ctx.sessions.use(ref, fn)` | as above |
| `ctx.sessions.connect({ controller?, host, port?, username, password, protocol? })` | `{ ref, session }`; registers an ad-hoc handle |
| `ctx.sessions.disconnect(ref)` | ends the controller session and forgets the handle |
| `ctx.sessions.list()` | `[{ ref, controller, host, connected, protocol, model }]`, with no credentials |
| `ctx.controllerFor(name?)` | `ControllerClient`; default controller when the name is omitted |
| `ctx.readOnly` | boolean |
| `ctx.log(level, msg)` | stderr logging (never stdout: stdio transport) |

## 5. ControllerClient (frozen interface)

`new ControllerClient({ name, url, token?, timeoutMs? })`. Every method
returns parsed JSON (or `{ buffer, contentType }` for images) or throws
`ControllerError { code, message, hint, status }`. The `code` comes from the
controller's error envelope. A network failure is `CONTROLLER_UNREACHABLE`.

```
health()  adapters()  discover(timeoutMs?)
connect({ host, port, username, password, protocol? })  session(id)  disconnect(id)
profiles(id)  snapshot(id, profile?) -> { buffer, contentType }  streamUrls(id)
targets(id)  describeSettings(id, target)  readSettings(id, target, keys?)  writeSettings(id, target, values)
imaging(id, profile?)  writeImaging(id, profile, settings)  focus(id, profile, body)
encoder(id, profile?)  writeEncoder(id, profile, settings)
network(id)  writeNetwork(id, patch)
device(id)  reboot(id)  syncTime(id)  setRelay(id, { token, state })
ptzMove(id, { profile, pan, tilt, zoom })  ptzStop(id, { profile })  ptzRelative(id, {…})  ptzAbsolute(id, {…})
ptzStatus(id, profile)  ptzPresets(id, profile)  ptzGotoPreset(id, { profile, token, speed? })
ptzSavePreset(id, { profile, name, token? })  ptzDeletePreset(id, profile, token)  ptzHome(id, { profile, action })
```

`token`, when set, is sent as `Authorization: Bearer <token>` (§7).

## 6. Configuration

`ONVIF_MCP_CONFIG` names a JSON file; the default is `mcp/config.json`, which
is gitignored. `mcp/config.example.json` is the template. A missing file
means one controller, `local`, at `ONVIF_CONTROLLER_URL` (default
`http://127.0.0.1:8080`), and no devices.

```json
{
  "controllers": [
    { "name": "local", "url": "http://127.0.0.1:8081" },
    { "name": "site-a", "url": "https://site-a.example:8443", "token": "env:SITE_A_CONTROLLER_TOKEN" }
  ],
  "devices": [
    { "name": "lobby-cam", "controller": "local", "host": "192.168.1.64", "port": 80,
      "username": "env:LOBBY_USER", "password": "env:LOBBY_PASS", "protocol": "auto",
      "label": "Lobby PTZ", "notes": "Faces the west windows; glare after 3pm." }
  ],
  "defaultController": "local"
}
```

- Any string value `"env:NAME"` is read from the environment at start-up.
  Secrets belong in env, not in the file.
- `notes` and `label` are shown to the agent (`list_devices`). Use them for
  site knowledge.

## 7. Remote controllers and auth

The controller has no authentication of its own (README). For remote use it
gains an **opt-in** bearer token (Stream 2):

- When `CONTROLLER_TOKEN` is set, every `/api/**` and `/ws/**` request must
  carry `Authorization: Bearer <token>`, compared in constant time. If it
  doesn't, the answer is `401` with the error envelope, code `UNAUTHORIZED`.
- **The browser UI keeps working.** Visiting `/?token=<token>` once sets an
  HttpOnly, SameSite=Strict cookie that is accepted in place of the header,
  then redirects to `/` so the token leaves the address bar. With
  `CONTROLLER_TOKEN` unset, behaviour is exactly as before.
- `/api/health` stays open (Docker healthcheck).
- Recommended remote setups, in this order: an SSH tunnel to the loopback
  port, or `CONTROLLER_TOKEN` + HTTPS via a reverse proxy.

The MCP server's own Streamable HTTP mode (`--http`) binds `127.0.0.1` by
default. Binding anything else requires `MCP_HTTP_TOKEN`, checked the same
way.

## 8. Tests

- Tests live in `tools/tests/mcp-*.mjs` and are picked up by
  `tools/run-tests.mjs`.
- `mcp/test/harness.mjs` boots a mock ONVIF camera and a controller on random
  ports, builds a context, and returns an in-memory MCP client:
  `const h = await startHarness(); await h.call('read_settings', {...}); await h.close();`.
  `h.call` returns the raw MCP result. `h.json(result)` parses the first JSON
  text block.
- Tests under `tools/tests/` import `z`, `Client` and `InMemoryTransport` **from
  the harness** (it re-exports them), because `zod` and the SDK live in
  `mcp/node_modules`. The runner skips `mcp-*` tests when `mcp/` deps are not
  installed (`npm install --prefix mcp`).
- Tests drive tools **through the MCP protocol** (the SDK `Client` over
  `InMemoryTransport`), so schemas, annotations, the confirm gate and error
  mapping are exercised exactly as an agent sees them.

## 9. Invariants

- Never send a password, token, or credentialed URL to the agent, the log, or
  an error message.
- Never write a value the agent did not ask for. Writes go through the
  controller's verified-write path and report per-field outcomes as returned.
- stdout belongs to the stdio transport. Log to stderr only.
- No change to the controller's behaviour when `CONTROLLER_TOKEN` is unset.
  The existing test suites stay green.
