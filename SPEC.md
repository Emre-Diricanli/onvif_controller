# ONVIF Controller — Specification

A local web app: enter a camera IP + credentials, connect, and get a full ONVIF
control surface with a low-latency live stream.

Target hardware: Hikvision IP cameras and NVRs (ONVIF Profile S/T), plus generic
ONVIF devices. Runs on the operator's laptop / a jump host on the same LAN.

---

## 1. Non-negotiable constraints

- **No build step.** Frontend is plain ES modules served statically by the
  backend. No Vite/webpack/babel/JSX. `npm install && npm start` is the whole setup.
- **No CDN / no network fetches at runtime.** The app must work on an air-gapped
  LAN. Every dependency is an npm package or vendored source.
- **Node.js >= 20.** CommonJS is banned; use ESM (`"type": "module"`).
- **ffmpeg is an external binary** resolved from `$PATH` (or `FFMPEG_PATH`).
  Never bundle it. Fail loudly with a readable error if missing.
- **Credentials never touch disk.** Sessions live in an in-memory `Map` only.
- **Never log a password**, not even at debug level.

## 2. Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 20+, ESM |
| HTTP | `express` |
| WebSocket | `ws` |
| ONVIF | `onvif` (agsh/onvif) — Profile S, PTZ, Imaging, Events |
| Streaming | `ffmpeg` child process → fragmented MP4 → WebSocket → MSE |
| Frontend | Vanilla ES modules, hand-rolled spring engine, no framework |

## 3. Repository layout

```
onvif controller/
├── package.json
├── README.md
├── SPEC.md                  # this file
├── API.md                   # the wire contract — the integration boundary
├── server/
│   ├── index.js             # express app, static hosting, wires routers + ws
│   ├── config.js            # env parsing, ffmpeg discovery
│   ├── sessions.js          # in-memory session store, TTL reaping
│   ├── onvif/
│   │   ├── connect.js       # probe + authenticate + capability matrix
│   │   ├── media.js         # profiles, stream URIs, snapshot, encoder config
│   │   ├── ptz.js           # move/stop/presets/tours/aux
│   │   ├── imaging.js       # imaging settings get/set + ranges
│   │   ├── events.js        # pullpoint subscription -> EventEmitter
│   │   └── device.js        # info, time, network, relay outputs, reboot
│   ├── routes/
│   │   ├── session.js       # /api/connect, /api/session/:id, disconnect
│   │   ├── ptz.js
│   │   ├── imaging.js
│   │   ├── media.js
│   │   └── device.js
│   └── stream/
│       ├── pipeline.js      # ffmpeg spawn/lifecycle/backpressure/restart
│       ├── ws.js            # /ws/stream + /ws/events handlers
│       └── snapshot.js      # JPEG snapshot proxy (fallback path)
└── public/
    ├── index.html
    ├── styles/
    │   ├── tokens.css       # color/type/spacing/material tokens, light+dark
    │   └── app.css
    └── js/
        ├── app.js           # router between Connect and Controller screens
        ├── api.js           # typed-ish fetch wrapper over API.md
        ├── spring.js        # rAF spring engine (see §6)
        ├── gesture.js       # pointer capture, velocity history, rubber-band
        ├── player.js        # MSE + WebSocket fMP4 player, snapshot fallback
        └── views/
            ├── connect.js   # IP + credentials screen
            ├── controller.js# main shell: stream + control panels
            ├── joystick.js  # PTZ pad
            ├── presets.js
            ├── imaging.js   # sliders
            └── events.js    # live event feed
```

## 4. Product surface

### Screen 1 — Connect
- Fields: Host/IP, Port (default 80), Username, Password, "Remember on this
  device" (localStorage, **host/port/username only — never the password**).
- Live validation: IP/hostname shape checked inline, not on submit.
- Connect button shows a determinate-ish progress narrative, because ONVIF
  handshakes are slow: `Reaching device… → Authenticating… → Reading
  capabilities… → Fetching profiles…`. Each step resolves in the UI as it lands.
- Errors are specific and actionable, never "Connection failed":
  - `ECONNREFUSED` → "Nothing is listening on {host}:{port}. On Hikvision, ONVIF
    is disabled by default — enable it under Network → Advanced → Integration Protocol."
  - 401 → "Device rejected those credentials. Hikvision requires a *separate*
    ONVIF user; the web-UI admin account will not work here."
  - Clock skew detected (device time vs local > 60s) → "Device clock is off by
    {n}. ONVIF digest auth will fail until NTP is fixed."
  - Timeout → "{host} did not answer in 10s. Check the subnet/VLAN route."
- A "Discover devices on this network" affordance runs WS-Discovery and lists
  responders so the user can click one instead of typing.

### Screen 2 — Controller
Layout: the video is the surface; controls are translucent layers over/around it.

- **Live stream** — the hero. Profile switcher (main/sub stream) if the device
  exposes more than one. Overlay chrome: resolution, codec, fps, bitrate,
  measured end-to-end latency, connection state.
- **PTZ pad** — an analog joystick, not 8 buttons. Drag from center; the offset
  vector maps to ONVIF `ContinuousMove` pan/tilt speed. Releasing springs the
  knob home and issues `Stop`. Separate zoom slider/rocker. Focus and iris
  controls when the Imaging service exposes them. Hidden entirely for fixed
  cameras — do not render dead controls.
- **Presets** — list, goto, save-current-as, rename, delete. Tours if supported.
- **Imaging** — sliders for brightness, contrast, saturation, sharpness; segmented
  control for IR-cut filter (Auto/On/Off), white balance, exposure mode, WDR,
  backlight compensation. Every slider's min/max/step comes from the device's
  reported `Options` range — never hardcode 0–100.
- **Device** — model, firmware, serial, MAC, uptime, time sync state, network
  config, relay outputs (toggle), reboot (confirm dialog).
- **Events** — live feed from the ONVIF pull-point subscription: motion, tamper,
  video loss, line crossing, I/O. Newest at top, timestamped, with a topic filter.
- **Capabilities** — the honest matrix of what this device actually supports.

### Capability-driven rendering
`GET /api/session/:id` returns a capability matrix. **Panels for unsupported
services are not rendered at all.** A greyed-out disabled control is worse than
an absent one — it implies the app is broken rather than the camera being fixed.

## 5. Streaming design

1. Resolve RTSP URI via ONVIF `GetStreamUri` for the chosen profile.
2. Inject credentials into the RTSP URL server-side. **The RTSP URL with
   credentials must never be sent to the browser.**
3. Spawn ffmpeg:
   - H.264 source → `-c:v copy` (no transcode, lowest latency and CPU)
   - H.265 / MJPEG source → `-c:v libx264 -preset ultrafast -tune zerolatency`
     (browsers cannot decode H.265 in MSE reliably)
   - Always `-rtsp_transport tcp` (UDP loses fragments across the VLANs here)
   - Output: `-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset -frag_duration 200000`
   - `-an` unless audio is explicitly enabled
4. Pipe stdout over the `/ws/stream` WebSocket as binary frames.
5. Browser feeds them to a `SourceBuffer`. Keep the buffer trimmed to ~10s and
   nudge `currentTime` toward the live edge if drift exceeds 1.5s.
6. **Fallback:** if MSE is unavailable, the codec is unsupported, or ffmpeg dies
   3× in 30s, degrade to `/api/snapshot` JPEG polling at 2fps and say so in the
   UI. Degrade visibly — never silently show a frozen frame.
7. One ffmpeg process per active viewer session; kill it on socket close, on
   session expiry, and on process exit. **A leaked ffmpeg is a P1 bug** — this
   runs next to a GPU fleet that already OOMs.

## 6. Motion system (the app must feel like `apple-design`)

Everything below is enforced in review; treat it as spec, not taste.

- **Springs, not CSS transitions**, for anything a pointer can touch. `spring.js`
  exposes `spring({ from, to, velocity, damping, response, onUpdate })` driven by
  `requestAnimationFrame`, animating from the **current presentation value**.
- Defaults: `damping 1.0`, `response 0.35`. Bounce (`damping 0.8`) **only** after
  a momentum gesture — a flick or drag release. Never on a panel that just appeared.
- **Interruptible always.** Re-targeting mid-flight carries current velocity
  through; no hard cuts, no input lockout during transitions.
- **1:1 tracking** with `setPointerCapture`, respecting the grab offset. Track the
  last ~5 pointer samples for release velocity.
- **Momentum projection** for anything that snaps:
  `project(v) = (v/1000) * 0.998 / (1 - 0.998)`.
- **Rubber-band** at the joystick's radius limit and at panel drag bounds —
  progressive resistance, never a hard stop.
- **Respond on pointerdown**, not on click. Continuous feedback during the whole
  gesture.
- **Translucent chrome**: control panels are `backdrop-filter: blur(20px)
  saturate(180%)` layers with the video visible beneath. Never stack two light
  translucent surfaces.
- **Spatial consistency**: a panel enters and exits along the same path, with
  `transform-origin` anchored to the control that opened it.
- **Typography**: `system-ui`. Size-specific tracking — headings `-0.02em`, body
  `0`. Spacing in `rem` so Dynamic Type scaling doesn't break layout.
- **Light and dark** both fully designed via `tokens.css`. Honor
  `prefers-reduced-motion` (cross-fade, drop overshoot),
  `prefers-reduced-transparency` (solid surfaces), `prefers-contrast: more`.
- Animate `transform` and `opacity` only. No layout-triggering properties in
  motion paths.

## 7. Error handling & resilience

- Every ONVIF call gets a timeout (default 10s) and maps SOAP faults to a stable
  `{ error: { code, message, hint } }` shape. `hint` is the operator-facing
  remediation sentence.
- Sessions expire after 30 min idle; expiry tears down ffmpeg and event
  subscriptions.
- Pull-point subscriptions auto-renew before expiry and resubscribe on failure
  with backoff.
- ffmpeg restarts with exponential backoff (1s, 2s, 4s), capped at 3 attempts
  before degrading to snapshot mode.
- The UI always shows true connection state. Optimistic UI is banned for anything
  that touches the camera — if a PTZ move failed, the knob must not pretend.

## 7a. PTZ safety

A continuous move runs until the camera is told to stop. That makes the stop
signal safety-critical, and the browser is not a trustworthy place to keep the
only copy of it: a closed tab, a slept laptop, or a dropped Wi-Fi link all end
the conversation without a stop, and the camera keeps panning into a mechanical
limit.

Three independent layers, in order of how much they can be trusted:

1. **Client**: release, `pointercancel`, `pointerleave`, and page-inactive
   (visibilitychange / pagehide / blur) all issue an immediate stop.
2. **Server dead-man watchdog**: a continuous move arms a 1.5s timer, re-armed
   by every keepalive. The joystick sends one every ~100ms while held, so
   silence for longer than that means the client is gone and the server stops
   the camera itself. This is the layer that actually holds when the browser
   dies.
3. **Session teardown**: disconnect, idle expiry, and shutdown each stop any
   in-flight move before dropping the device connection.

Layers 2 and 3 are covered by `tools/smoke.mjs`, including the negative case —
a held joystick must not be interrupted by the watchdog.

## 8. Security posture

- Binds `127.0.0.1` by default. `--host 0.0.0.0` must be an explicit opt-in flag
  that prints a warning.
- Session IDs are `crypto.randomUUID()`.
- Camera host is validated to block SSRF into cloud metadata endpoints
  (`169.254.169.254`) — this app is used from hosts inside AWS.
- No credential, RTSP URL, or session ID is ever written to a log line.

## 9. Definition of done

- `npm install && npm start` → open `http://localhost:8080` → enter IP + creds →
  live video within 5s and working PTZ.
- The app runs correctly against a device that supports *only* Profile S with no
  PTZ and no Imaging (panels absent, no crashes, no dead controls).
- Killing the camera mid-stream shows a reconnecting state and recovers when it
  returns.
- No orphaned ffmpeg processes after closing the browser tab. Verified with `ps`.
- Every interactive element responds on pointerdown and is interruptible.
