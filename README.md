# ONVIF Controller

A local web app for driving an ONVIF camera: enter an IP and credentials, get a
low-latency live stream plus PTZ, presets, imaging, events, and device control.

Built for Hikvision cameras and NVRs, and works with any ONVIF Profile S device.

## Device settings over any protocol

ONVIF is one way in, not the only one. The **All settings** panel, and the
`/api/session/:id/settings` API behind it, read and change camera and recorder
settings through whichever API the device actually answers:

| Adapter | Protocol | Verification |
| --- | --- | --- |
| `onvif` | ONVIF Imaging + Media | device-verified (existing paths) |
| `hikvision` | Hikvision ISAPI | mock-verified |
| `dahua` | Dahua HTTP API (CGI), including Lorex OEM recorders | mock-verified |
| `axis` | Axis VAPIX | mock-verified |
| `reolink` | Reolink JSON CGI | mock-verified |
| `uniview` | Uniview LiteAPI | mock-verified |

**Protocol → Automatic** on the Connect screen tries ONVIF first. If ONVIF is
off or refuses the credentials, it asks the device in its own API. This is
the usual case on recorders that ship with ONVIF disabled. A device reached
that way gets a settings-only screen, because live video and PTZ still need
ONVIF.

Every write is read back and reported per field as one of `applied`,
`adjusted`, `unchanged`, `rejected` or `unknown`. The app never reports a
change as done just because the device said "OK".

"Mock-verified" means the adapter passes its conformance suite against a
persona built from the vendor's documented API. It has not yet been confirmed
on hardware. `node tools/probe-dahua.mjs` and `tools/probe-isapi.mjs` are
read-only tools for checking a real unit. To add a vendor, see
`ADAPTERS.md`.

## Let an AI agent drive it (MCP)

`mcp/` is a Model Context Protocol server. Point Claude Code, Claude Desktop,
or any MCP client at a camera and it can see snapshots, read and change
settings with verified results, and drive PTZ, on local or remote
controllers. Disruptive actions always need your confirmation.

```
npm install --prefix mcp
claude            # this repo ships .mcp.json; approve "onvif-controller"
```

See [`mcp/README.md`](mcp/README.md) for remote controllers, saved devices
and the tool list.

## Requirements

- Node.js 20 or newer
- `ffmpeg` on your `PATH` (macOS: `brew install ffmpeg`), or `FFMPEG_PATH` set

## Run

```
npm install
npm start
```

Open http://localhost:8080, enter the camera's IP, port (usually 80), and the
ONVIF username and password.

The server binds `127.0.0.1` by default. It has no authentication of its own —
anything that can reach the port can pan the camera and reboot it — so exposing
it requires an explicit `--host 0.0.0.0`, which prints a warning.

## Run with Docker

The image pins a known-good Node 20 and **ffmpeg**, which is the setup step that
fails most often. Nothing else about the app changes.

```
npm run up
```

(`./docker/up.sh` does the same thing without npm.) It builds the image,
starts it in the background, waits for the healthcheck, and prints the
address to open:

```
  ONVIF Controller is running — open http://127.0.0.1:8080
```

If port 8080 is already taken on your machine, it says so before starting. Pick
another port with `HOST_PORT=8081 npm run up`, or make it permanent with
`echo HOST_PORT=8081 > .env`.

Plain `docker compose up -d --build` works too, but detached mode shows only
Compose's own status, so the address is not printed. Use
`docker compose logs --tail 3` to see it, or run `docker compose up --build`
in the foreground, where it is the last startup line.

Open http://127.0.0.1:8080. If 8080 is taken, pick another host port with
`HOST_PORT=8081 docker compose up` — it stays bound to `127.0.0.1`.

**The published address is the security boundary.** The app has no
authentication of its own, so `compose.yaml` publishes to `127.0.0.1` only:

```yaml
ports: ["127.0.0.1:8080:8080"]   # correct
ports: ["8080:8080"]             # exposes camera control to your whole LAN
```

Inside the container the app binds `0.0.0.0` — it has to, or nothing could
reach it — so it prints its usual "binding 0.0.0.0 exposes full camera control"
warning on every start. In a container that warning is about the *container's*
network namespace; what actually decides who can reach the app is the published
address above. Keep it on `127.0.0.1` unless you have deliberately put an
authenticated proxy in front.

### What does not work in a container

**Device discovery.** `Discover devices on this network` uses WS-Discovery, UDP
multicast to `239.255.255.250`, which does not cross Docker's bridge network.
It will find nothing. Connecting by IP — the normal path — works fine.

If you genuinely need discovery, run with host networking and understand that it
removes the published-port boundary entirely:

```
docker run --network host onvif-controller     # discovery works, no port isolation
```

### Webhook targets

Fan-out targets live in a JSON file that may contain an HMAC secret, so it is
mounted rather than baked into the image:

```
FANOUT_CONFIG=./fanout.json docker compose up
```

Never commit that file, and never put the secret in `compose.yaml`.

## Hikvision notes

Two things trip up almost every first connection:

1. **ONVIF is disabled by default.** Enable it in the camera's web UI under
   *Network → Advanced Settings → Integration Protocol*.
2. **The admin account will not work.** ONVIF needs its own user, created on that
   same page. Using the web-UI admin credentials returns a 401.

A third, less obvious one: ONVIF digest auth signs a timestamp, so more than a
few seconds of clock drift makes every request fail as "not authorized". The
Connect screen reports the measured skew, and the Device panel has a one-click
time sync.

## Development

A mock ONVIF device is included so you can work without hardware. It replays the
SOAP fixtures that ship inside the `onvif` package.

```
node tools/mock-camera.js 10101     # then connect to 127.0.0.1:10101
```

Environment switches for testing failure paths:

| Variable | Effect |
| --- | --- |
| `MOCK_REJECT_AUTH=1` | Every authenticated call returns 401 |
| `MOCK_SKEW_SECONDS=600` | Device clock reports 10 minutes behind |
| `MOCK_IMAGING_MODE=ignore` | Imaging writes report success but change nothing |
| `MOCK_IMAGING_MODE=clamp` | Device clamps brightness to a lower maximum |

`MOCK_IMAGING_MODE=ignore` reproduces the real Hikvision behaviour where a
brightness change appears to succeed and the picture never changes.

### Debugging a camera that won't apply a setting

```
DEBUG_ONVIF=1 npm start
```

Logs the outgoing SetImagingSettings SOAP body and the device's raw response, so
you can see exactly what the camera was asked and what it said back. Credentials
and RTSP URLs are never logged.

The mock has no RTSP source, so live video will not play against it — use it for
the control surface, capability probing, and error paths.

### Smoke test

```
node tools/smoke.mjs          # add VERBOSE=1 to see server output
```

Boots the mock device and the app on scratch ports and asserts the API contract
plus the Definition of Done items from `SPEC.md`: error envelopes, credential
non-leakage, capability-driven behavior, the PTZ safety layers, both
WebSockets, same-origin rejection, and that no ffmpeg processes are left behind.

The mock has no RTSP source, so the video path is exercised through
`tools/fake-ffmpeg.mjs` instead — a shim that the pipeline resolves via
`FFMPEG_PATH`. It swaps only the `-i <rtsp url>` input for a synthetic test
pattern and passes every other argument the pipeline chose straight through, so
the fragmented-MP4 box parser, the codec-string extraction, the WebSocket
framing and the process teardown are all genuinely under test. Only the RTSP
negotiation itself is not.

To run the suite against your real ffmpeg (video assertions will fail without a
camera, everything else still runs):

```
SMOKE_REAL_FFMPEG=1 node tools/smoke.mjs
```

## Known device quirks

Not every camera that advertises an ONVIF service actually implements it. Two
real cases this app now handles explicitly rather than failing confusingly:

- **Imaging that never applies.** Some budget cameras report adjustable ranges,
  answer `SetImagingSettings` with a success envelope, and keep their own
  values. Verified on a Vatilon "Sinis 5MP IPC" against five different SOAP
  shapes — all ignored. The Imaging section detects this and says so instead of
  repeating a per-slider error; the fix is the camera's own app, not this one.
- **Imaging that only works over a proprietary API.** Where ONVIF is a stub, the
  app falls back to the camera's own HTTP API. ONVIF is always tried first; a
  vendor driver is consulted only after ONVIF has been caught accepting a write
  and changing nothing, and the UI says when that is happening. Drivers live in
  `server/vendor/`; the protocol and the driver interface are in `VENDOR.md`.
  Set `VENDOR_HTTP_PORT` if a camera's web UI is not on port 80.
- **An event subscription that kills the process.** The `onvif` library calls
  `unsubscribe()` from inside its own PullMessages error path and throws
  synchronously when the subscription has already lapsed. Because it throws from
  a callback, nothing upstream can catch it, and it terminated the whole server
  mid-stream. `server/onvif/events.js` guards the method on each instance, and
  `server/index.js` keeps a last-resort `uncaughtException` handler so no
  third-party throw can end an operator's live view.

## Documents

- `SPEC.md` — product and design contract, including the motion system
- `API.md` — the HTTP and WebSocket wire protocol
- `ADAPTERS.md` — the device-adapter contract: settings model, verified writes, transport rules
- `MCP.md` — the MCP server contract: tools, safety gates, sessions, remote auth
- `INTERNAL.md` — module boundaries and import signatures
