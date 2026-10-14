# ONVIF Controller MCP server

Point an AI agent at a camera or recorder and let it look, think and adjust.
It sees snapshots, reads every setting with its real range and units, changes
them through the controller's verified-write path, drives PTZ, and reports
what the device *actually* did.

The server talks to one or more running ONVIF Controller instances, on this
machine or on remote site boxes. Every protocol the controller speaks works
here too: ONVIF, Hikvision ISAPI, Dahua/Lorex, Axis VAPIX, Reolink and
Uniview. The contract is in [`../MCP.md`](../MCP.md).

## Install

```
npm install --prefix mcp
```

You also need a controller running somewhere: `npm run up` (Docker) or
`npm start` in the repo root.

## Connect an agent

**Claude Code** (from this repo; `.mcp.json` is already here):

```
claude          # then approve the "onvif-controller" MCP server
```

or anywhere:

```
claude mcp add onvif-controller -e ONVIF_CONTROLLER_URL=http://127.0.0.1:8081 -- node "/path/to/onvif controller/mcp/index.js"
```

**Claude Desktop, or any MCP client using stdio:**

```json
{
  "mcpServers": {
    "onvif-controller": {
      "command": "node",
      "args": ["/path/to/onvif controller/mcp/index.js"],
      "env": { "ONVIF_CONTROLLER_URL": "http://127.0.0.1:8081" }
    }
  }
}
```

**Remote agents (Streamable HTTP):**

```
MCP_HTTP_TOKEN=<long random secret> node mcp/index.js --http --port 8770
```

This serves `http://127.0.0.1:8770/mcp`, and clients send
`Authorization: Bearer <secret>`. It binds loopback by default. Binding
another address (`--host 0.0.0.0`) is refused unless `MCP_HTTP_TOKEN` is set.
Put HTTPS in front of it before exposing it beyond a trusted network.

## Configure controllers and devices

Copy `config.example.json` to `config.json` (gitignored), or point
`ONVIF_MCP_CONFIG` at a file. With no config there is one controller at
`ONVIF_CONTROLLER_URL` (default `http://127.0.0.1:8080`) and no saved devices.
The agent can still open any camera by address with `connect_device`.

- **Secrets come from the environment.** Write `"password": "env:LOBBY_PASS"`
  in the file and the value is read from `$LOBBY_PASS` at start-up. The
  agent never sees credentials: it refers to devices by name.
- **`notes`** on a device are shown to the agent. Put site knowledge there
  ("faces west windows, glare after 3pm").
- **Remote controllers:** give each one a `token` (`"env:SITE_A_TOKEN"`) and
  start that controller with the same `CONTROLLER_TOKEN`. Prefer an SSH
  tunnel to its loopback port, or HTTPS through a reverse proxy.

## Safety

- **Look before you touch.** The server's instructions tell the agent to
  read settings and take a snapshot before writing.
- **Every write is verified.** The result says `applied`, `adjusted`,
  `unchanged` (the device ignored it), `rejected` or `unknown`. The agent is
  told never to blindly retry `unknown`.
- **Disruptive actions need `confirm: true`.** This covers reboot, relay
  outputs, deleting presets, and codec or resolution changes that restart
  streams. The server refuses them until the agent has asked you and you
  agreed. The server enforces this, not the agent's good manners.
- **`MCP_READ_ONLY=1`** turns the whole server into an observer: only
  read-only tools run.
- No password, token, or credentialed stream URL is ever returned to the
  agent or written to the log.

## Tools

| Tool | What it does |
| --- | --- |
| `list_controllers` | Controllers, whether they're reachable, and which protocols each speaks |
| `list_devices`, `discover_devices` | Saved devices, open sessions, WS-Discovery |
| `connect_device`, `disconnect_device` | Open a camera by address (credentials kept in memory only), close it |
| `device_info` | Make, model, firmware, streams, PTZ support, clock skew |
| `list_targets`, `describe_settings`, `read_settings` | Channels, sources and streams; every setting with type, range and unit; current values |
| `write_settings` | Picture and other non-disruptive settings, with `dry_run`; per-field verified outcomes |
| `write_stream_settings` | Encoder changes (codec, resolution, fps, bitrate) — confirm required |
| `get_snapshot` | A JPEG the agent can see |
| `ptz_move` (always auto-stops), `ptz_stop`, `ptz_status`, `ptz_go_home`, presets | Pan/tilt/zoom |
| `sync_time`, `reboot_device`, `set_relay` | Maintenance; reboot and relay require confirm |

**Prompts:** `tune_picture`, `optimize_stream` and `diagnose_device` are
expert workflows an agent (or you, from the client's prompt menu) can start
from.

## Develop

```
node tools/tests/mcp-core.mjs        # or: npm test (runs every tools/tests/mcp-*.mjs)
```

The tests boot a mock camera and a real controller, and call tools through
the MCP protocol exactly as an agent does (`mcp/test/harness.mjs`). To add a
tool, put a module in `mcp/tools/` exporting `tools` (MCP.md §3). It is
discovered automatically.
