# ONVIF Controller

A local web app for driving an ONVIF camera: enter an IP and credentials, get a
low-latency live stream plus PTZ, presets, imaging, events, and device control.

Built for Hikvision cameras and NVRs, and works with any ONVIF Profile S device.

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

## Documents

- `SPEC.md` — product and design contract, including the motion system
- `API.md` — the HTTP and WebSocket wire protocol
- `INTERNAL.md` — module boundaries and import signatures
