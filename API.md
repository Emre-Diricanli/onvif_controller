# API Contract — the integration boundary

**This file is frozen. All three work streams build against it.**
Backend implements it exactly; frontend consumes it exactly. If a change is
genuinely required, change it here first and say so loudly in the branch summary.

Base URL: `http://localhost:8080`
All request and response bodies are JSON unless stated otherwise.

## Authentication

Authentication is opt-in. With `CONTROLLER_TOKEN` unset or empty, existing
HTTP and WebSocket behavior is unchanged. When set, every `/api/**` request
except `GET /api/health` (and `HEAD`), and every `/ws/**` upgrade, requires either
`Authorization: Bearer <token>` or a valid browser authentication cookie.
Bearer values are compared using constant-time comparison for equal-length
buffers. Failed API requests and upgrades return HTTP 401 with the normal
error envelope, code `UNAUTHORIZED`; they never echo supplied credentials.

For browser access, visit `/?token=<token>` once (any static path also works).
A correct token sets a session cookie with `HttpOnly`, `SameSite=Strict`, and
`Path=/`, then redirects with HTTP 302 to the same path and other query
parameters, removing all `token` parameters. The cookie contains an HMAC,
not the bearer token, and becomes invalid when the controller restarts.
Invalid login tokens return a 401 page. Static assets remain public. Existing
same-origin checks still apply to authenticated requests and WebSockets.
Avoid sharing login links or recording their query strings in proxy logs.

For remote access, prefer an SSH tunnel to the loopback listener, or set
`CONTROLLER_TOKEN` and terminate HTTPS at a reverse proxy with a trusted
certificate. MCP uses normal TLS verification; it does not offer
`insecureTls`. Configure the proxy to redact login query strings and add
`Secure` to the authentication cookie when terminating HTTPS (direct HTTPS
requests already set it). Token authentication alone does not encrypt traffic.
The controller warns when bound beyond loopback without a token.

MCP controller configuration supports optional `allowHosts: ["192.168.1.0/24",
"camera.example", "2001:db8::/32"]`. It restricts ad-hoc connections only;
configured devices remain explicitly trusted. Hostnames match exact names
(case-insensitively), and CIDRs match literal IPv4/IPv6 addresses. MCP does
not resolve DNS locally to authorize a hostname against a CIDR, because a
remote controller may resolve names differently. An empty list denies all
ad-hoc connections; omission leaves them unrestricted.

## Error envelope

Every non-2xx response uses this shape, with no exceptions:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Device rejected the supplied credentials.",
    "hint": "Hikvision requires a separate ONVIF user; the web-UI admin account will not work."
  }
}
```

Codes: `BAD_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `SESSION_EXPIRED`,
`DEVICE_UNREACHABLE`, `DEVICE_TIMEOUT`, `CLOCK_SKEW`, `UNSUPPORTED`,
`FFMPEG_MISSING`, `STREAM_FAILED`, `DEVICE_ERROR`, `INTERNAL`.

`hint` may be `null`. `message` is always a complete sentence.

---

## Session

### `POST /api/connect`
```json
{ "host": "192.168.1.64", "port": 80, "username": "onvif", "password": "•••" }
```
→ `200`
```json
{
  "sessionId": "b1f0…",
  "device": {
    "manufacturer": "Hikvision",
    "model": "DS-2CD2143G0-I",
    "firmware": "V5.6.3",
    "serial": "…",
    "hardwareId": "…",
    "deviceTime": "2026-08-24T17:30:02.000Z",
    "localTime": "2026-08-24T17:30:03.100Z",
    "clockSkewSeconds": 1.1
  },
  "capabilities": {
    "media": true, "media2": false, "ptz": true, "imaging": true,
    "events": true, "analytics": false, "recording": false,
    "deviceIO": true, "relayOutputs": 1, "audioBackchannel": false
  },
  "profiles": [
    {
      "token": "Profile_1", "name": "mainStream",
      "video": { "codec": "H264", "width": 2560, "height": 1440, "fps": 20, "bitrate": 4096 },
      "audio": { "codec": "G711", "bitrate": 64 },
      "ptzSupported": true, "snapshotSupported": true
    }
  ],
  "ptz": {
    "spaces": { "panTilt": { "xMin": -1, "xMax": 1, "yMin": -1, "yMax": 1 }, "zoom": { "min": 0, "max": 1 } },
    "presetsSupported": true, "toursSupported": false,
    "auxCommands": ["tt:Wiper|On", "tt:Wiper|Off", "tt:IRLamp|On", "tt:IRLamp|Off"],
    "homeSupported": true
  }
}
```
`ptz` is `null` when `capabilities.ptz` is false.

`capabilities` is derived from GetServices where the device supports it, falling
back to GetCapabilities on older firmware. `relayOutputs` is the count actually
returned by GetRelayOutputs, not a capability flag — devices advertise deviceIO
without relays and vice versa.

`protocol` (optional, default `"auto"`) picks how to reach the device:

- `"auto"`: ONVIF first. If ONVIF fails in a way that says nothing about the
  device's own API (`UNAUTHORIZED`, `DEVICE_ERROR`, `UNSUPPORTED`,
  `DEVICE_UNREACHABLE`, `CLOCK_SKEW`) and the host accepts TCP, every installed
  vendor adapter is probed one at a time. The best match connects. If nothing
  matches, the original ONVIF error is returned. If a vendor matched but refused
  the credentials, that `UNAUTHORIZED` is returned instead, as the more
  specific diagnosis.
- `"onvif"`: ONVIF only. This is the pre-adapter behaviour.
- `"<adapterId>"` (from `GET /api/adapters`): that vendor API only.

Every session response carries `"protocol"`: `"onvif"` or the adapter id. A
vendor-only session has empty `profiles`/`sources`, `ptz: null`, and every
capability `false` except `settings: true`. Routes that need ONVIF (stream,
snapshot, PTZ, imaging, encoder, device, network, playback) answer
`501 UNSUPPORTED` for it. Use the Settings routes below.

### `GET /api/adapters`
→ `{ "adapters": [{ "id": "hikvision", "label": "Hikvision ISAPI", "defaultPorts": [80] }, …] }`
in probe order. `onvif` is always present.

### `GET /api/session/:id`
→ the same payload as `/api/connect`, minus `sessionId`. Used to rehydrate the UI.
→ `404 SESSION_EXPIRED` when unknown or reaped.

### `POST /api/session/:id/disconnect`
→ `204`. Tears down ffmpeg, event subscriptions, and the session entry.

### `POST /api/discover`
```json
{ "timeoutMs": 5000 }
```
→ `200`
```json
{ "devices": [ { "host": "192.168.1.64", "port": 80, "name": "HIKVISION DS-2CD2143G0-I", "hardware": "…", "xaddrs": ["http://192.168.1.64/onvif/device_service"] } ] }
```
WS-Discovery multicast probe. Never blocks longer than `timeoutMs`.

---

## Media

### `GET /api/session/:id/profiles`
→ `{ "profiles": [ … ] }` — same profile objects as above.

### `GET /api/session/:id/snapshot?profile=Profile_1`
→ `200 image/jpeg`, binary. Server-side proxied and authenticated.
Sets `Cache-Control: no-store`. This is the streaming fallback path.

### `POST /api/session/:id/stream/start`
```json
{ "profile": "Profile_1" }
```
→ `200`
```json
{ "streamId": "s-9f3…", "transcoding": false, "codec": "H264",
  "mime": "video/mp4; codecs=\"avc1.640028\"",
  "width": 2560, "height": 1440, "fps": 20 }
```
`transcoding: true` means the source was H.265/MJPEG and is being re-encoded to
H.264. `mime` is passed straight to `MediaSource.isTypeSupported` and
`addSourceBuffer`.

### `POST /api/session/:id/stream/stop`
```json
{ "streamId": "s-9f3…" }
```
→ `204`

---

## PTZ

All PTZ vectors are normalized to `-1.0 … 1.0`. The backend maps them onto the
device's actual PTZ space. `speed` is `0.0 … 1.0`.

### `POST /api/session/:id/ptz/move`
```json
{ "profile": "Profile_1", "pan": 0.4, "tilt": -0.2, "zoom": 0 }
```
`ContinuousMove`. Non-blocking; returns immediately. The client re-sends this at
most every 100ms while the joystick is held — the backend must coalesce and never
queue a backlog.
→ `204`

### `POST /api/session/:id/ptz/stop`
```json
{ "profile": "Profile_1", "panTilt": true, "zoom": true }
```
→ `204`. Must be idempotent and must never fail loudly if nothing was moving.

### `POST /api/session/:id/ptz/relative`
```json
{ "profile": "Profile_1", "pan": 0.05, "tilt": 0, "zoom": 0, "speed": 0.5 }
```
→ `204`

### `POST /api/session/:id/ptz/absolute`
```json
{ "profile": "Profile_1", "pan": 0.0, "tilt": 0.0, "zoom": 0.3, "speed": 0.5 }
```
→ `204`

### `GET /api/session/:id/ptz/status?profile=Profile_1`
→ `{ "position": { "pan": 0.1, "tilt": -0.4, "zoom": 0.0 }, "moving": false, "utcTime": "…" }`

### `GET /api/session/:id/ptz/presets?profile=Profile_1`
→ `{ "presets": [ { "token": "1", "name": "Front Door", "position": { "pan": 0.1, "tilt": 0, "zoom": 0 } } ] }`

### `POST /api/session/:id/ptz/presets/goto`
```json
{ "profile": "Profile_1", "token": "1", "speed": 0.6 }
```
→ `204`

### `POST /api/session/:id/ptz/presets`
```json
{ "profile": "Profile_1", "name": "Loading Bay", "token": null }
```
Saves the **current** position. `token: null` creates; a token overwrites.
→ `{ "token": "4", "name": "Loading Bay" }`

### `DELETE /api/session/:id/ptz/presets/:token?profile=Profile_1`
→ `204`

### `POST /api/session/:id/ptz/home`
```json
{ "profile": "Profile_1", "action": "goto" }
```
`action` is `goto` or `set`. → `204`

### `POST /api/session/:id/ptz/aux`
```json
{ "profile": "Profile_1", "command": "tt:Wiper|On" }
```
→ `204`

---

## Imaging

### `GET /api/session/:id/imaging?profile=Profile_1`
→
```json
{
  "settings": {
    "brightness": 50, "contrast": 50, "colorSaturation": 50, "sharpness": 50,
    "irCutFilter": "AUTO",
    "whiteBalance": { "mode": "AUTO", "crGain": null, "cbGain": null },
    "exposure": { "mode": "AUTO", "minExposureTime": 10, "maxExposureTime": 40000, "minGain": 0, "maxGain": 100 },
    "focus": { "autoFocusMode": "AUTO", "defaultSpeed": 0.5, "nearLimit": 0, "farLimit": 1 },
    "wideDynamicRange": { "mode": "OFF", "level": 0 },
    "backlightCompensation": { "mode": "OFF", "level": 0 }
  },
  "options": {
    "brightness": { "min": 0, "max": 100, "step": 1 },
    "contrast": { "min": 0, "max": 100, "step": 1 },
    "colorSaturation": { "min": 0, "max": 100, "step": 1 },
    "sharpness": { "min": 0, "max": 100, "step": 1 },
    "irCutFilter": ["AUTO", "ON", "OFF"],
    "whiteBalanceModes": ["AUTO", "MANUAL"],
    "exposureModes": ["AUTO", "MANUAL"],
    "autoFocusModes": ["AUTO", "MANUAL"],
    "wideDynamicRangeModes": ["OFF", "ON"],
    "backlightCompensationModes": ["OFF", "ON"]
  }
}
```
**Any key may be absent** when the device does not expose it. The UI renders only
what is present, and slider bounds come from `options` — never hardcoded.

### `PATCH /api/session/:id/imaging`
```json
{ "profile": "Profile_1", "settings": { "brightness": 60, "irCutFilter": "ON" } }
```
Partial update; only supplied keys change.
→ the same shape as `GET`, reflecting the device's post-write state, plus an
`applied` object reporting whether each patched field actually took:

```json
{
  "settings": { "brightness": 255, "...": "..." },
  "options":  { "...": "..." },
  "applied":  { "brightness": true }
}
```

Both the `GET` and `PATCH` imaging responses also carry:

- `source` — `"onvif"`, or a vendor driver id (e.g. `"vatilon"`) when the
  picture is being driven through a camera's proprietary API instead.
- `driver` — a human-readable driver name, present only when `source` is not
  `"onvif"`.

ONVIF is always tried first. A vendor driver is consulted only after ONVIF has
been observed to accept a write and change nothing, and only for that session.
If the vendor path fails, the response falls back to ONVIF's honest result
rather than erroring. See `VENDOR.md`.

`applied[field]` is `false` when the device still reports the previous value
after the write and a short confirmation poll. This is not hypothetical: some
Hikvision firmware answers SetImagingSettings with success and silently keeps
the old value. Clamping is *not* a failure — a device that accepts 200 when 255
was requested reports `applied: true` and `settings.brightness: 200`, and the UI
shows the device's real value.

Note that ONVIF `SetImagingSettings` **replaces** the imaging settings
structure. The server always sends the complete merged block (current settings
overlaid with the patch), restricted to fields the device itself reported —
sending only the changed field makes most Hikvision firmware ignore the write
entirely.

### `POST /api/session/:id/imaging/focus`
```json
{ "profile": "Profile_1", "action": "continuous", "speed": 0.4 }
```
`action`: `continuous` | `stop` | `absolute` (with `position`). → `204`

---

## Device

### `GET /api/session/:id/device`
→
```json
{
  "info": { "manufacturer": "…", "model": "…", "firmware": "…", "serial": "…", "hardwareId": "…" },
  "network": { "hostname": "…", "dhcp": true, "interfaces": [ { "name": "eth0", "mac": "…", "ipv4": "192.168.1.64", "prefix": 24 } ], "dns": ["8.8.8.8"], "ntp": ["pool.ntp.org"], "gateway": "192.168.1.1" },
  "time": { "deviceTime": "…", "localTime": "…", "skewSeconds": 1.1, "timezone": "…", "ntpEnabled": true },
  "relayOutputs": [ { "token": "RelayOutput_0", "state": "inactive", "mode": "Bistable", "idleState": "closed" } ]
}
```

### `POST /api/session/:id/device/relay`
```json
{ "token": "RelayOutput_0", "state": "active" }
```
→ `204`

### `POST /api/session/:id/device/reboot`
→ `202 { "message": "Reboot command accepted." }`

### `POST /api/session/:id/device/synctime`
Sets the device clock from the server clock. → `204`

---

## Settings (protocol-neutral)

The same four calls work on any session, whatever protocol reached the
device. The contract behind them is ADAPTERS.md. Values use the device's
native units and ranges, which the descriptors declare. Every response names
the adapter (`source`) that produced it.

### `GET /api/session/:id/targets`
```json
{ "protocol": "onvif", "targets": [
  { "id": "source:VideoSource_1", "scope": "source", "label": "Channel 1", "channel": 1 },
  { "id": "stream:Profile_1", "scope": "stream", "label": "Channel 1 · mainStream", "channel": 1, "parent": "source:VideoSource_1" }
] }
```
`id` is opaque. Send it back verbatim. `scope` is one of
`device | channel | source | stream`.

### `GET /api/session/:id/settings/describe?target=<id>`
```json
{ "target": "source:VideoSource_1", "source": "onvif", "descriptors": [
  { "key": "image.brightness", "label": "Brightness", "group": "imaging", "type": "number",
    "unit": null, "min": 0, "max": 100, "step": 1, "writable": true, "resource": "imaging:VideoSource_1" },
  { "key": "image.dayNight", "label": "Day/night (IR-cut)", "group": "imaging", "type": "enum",
    "values": ["auto", "day", "night"], "unit": null, "writable": true, "resource": "imaging:VideoSource_1" }
] }
```
Keys are canonical (ADAPTERS.md §4) or `vendor.<adapterId>.<name>`.

### `GET /api/session/:id/settings?target=<id>[&keys=a,b]`
→ `{ "target": "…", "values": { "image.brightness": 50, … }, "source": "onvif" }`

### `PATCH /api/session/:id/settings`
```json
{ "target": "source:VideoSource_1", "values": { "image.brightness": 70, "image.dayNight": "night" } }
```
→ `200`
```json
{
  "target": "source:VideoSource_1",
  "source": "onvif",
  "results": {
    "image.brightness": { "outcome": "applied", "requested": 70, "observed": 70 },
    "image.dayNight":   { "outcome": "unchanged", "requested": "night", "observed": "auto" }
  },
  "values": { "image.brightness": 70, "image.dayNight": "auto" }
}
```
An unknown key, a read-only key, a wrong type, or an out-of-range value is
`400 BAD_REQUEST` before anything is sent. `outcome` is one of:

| outcome | meaning |
| --- | --- |
| `applied` | the read-back equals the requested value |
| `adjusted` | the value changed, but to something else (clamped or quantized) |
| `unchanged` | the device ignored the write |
| `rejected` | the device explicitly refused that field |
| `unknown` | the write was sent but could not be confirmed. Check before retrying |

When an ONVIF write comes back with **every** field `unchanged` (the stub
signature), and a vendor adapter answers on the same host
(`VENDOR_HTTP_PORT`, default 80), the write is retried there once. That only
happens on a single-source device whose vendor API exposes exactly one channel
and every requested key. The response then carries
`"source": "<adapterId>", "fallbackFrom": "onvif"`, and later calls for that
target go to the vendor adapter. There is never a fallback after `unknown` or
a transport error.

For an ONVIF `stream:` target, the response also carries
`streamRestartRequired` and `streamsRestarted`, with the same meaning as
`PATCH /encoder`.

## WebSockets

### `/ws/stream?session={id}&stream={streamId}`
- **Binary** messages: raw fragmented-MP4 byte chunks. The first message is the
  init segment (`ftyp` + `moov`); all subsequent are media fragments
  (`moof` + `mdat`). Feed them into the `SourceBuffer` in arrival order.
- **Text** messages: JSON control frames.
```json
{ "type": "ready", "mime": "video/mp4; codecs=\"avc1.640028\"" }
{ "type": "stats", "bitrateKbps": 3900, "fps": 20.0, "droppedFrames": 0 }
{ "type": "degraded", "reason": "ffmpeg exited 3 times", "fallback": "snapshot" }
{ "type": "error", "code": "STREAM_FAILED", "message": "…" }
```
Server closes with code `4001` on session expiry, `4002` on stream stop.

### `/ws/events?session={id}`
Text JSON only, one event per message:
```json
{
  "type": "event",
  "topic": "tns1:RuleEngine/CellMotionDetector/Motion",
  "shortTopic": "Motion",
  "utcTime": "2026-08-24T17:31:00.000Z",
  "source": { "VideoSourceConfigurationToken": "VideoSourceToken" },
  "data": { "IsMotion": true },
  "state": true
}
```
Plus lifecycle frames: `{ "type": "subscribed" }`,
`{ "type": "resubscribing", "attempt": 2 }`,
`{ "type": "error", "code": "…", "message": "…" }`.

Client sends `{ "type": "ping" }` every 25s; server replies `{ "type": "pong" }`.
