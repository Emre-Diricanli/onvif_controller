# Internal module contract

`API.md` is the wire contract between browser and server. **This file is the
contract between modules**, so that work happening in parallel integrates without
rewrites. Import signatures here are frozen. Implement your own modules; import
everyone else's exactly as written.

---

## Ownership map

| Area | Owner | Must not be touched by others |
| --- | --- | --- |
| `server/index.js`, `config.js`, `sessions.js`, `onvif/**`, `routes/**`, `ws/events.js` | **core** | yes |
| `server/stream/**`, `public/js/player.js`, `public/styles/player.css` | **streaming** | yes |
| `public/index.html`, `public/styles/tokens.css`, `public/styles/app.css`, `public/js/{app,api,spring,gesture}.js`, `public/js/views/**` | **frontend** | yes |

If you need a change in someone else's file, **do not edit it** — note the request
in your commit message instead.

---

## Session object

Created and owned by `server/sessions.js`. Consumed by everyone.

```js
/**
 * @typedef {Object} Session
 * @property {string}  id           crypto.randomUUID()
 * @property {string}  host
 * @property {number}  port
 * @property {string}  username
 * @property {string}  password     never logged, never serialized to the client
 * @property {object}  cam          connected `onvif` Cam instance
 * @property {object}  device       API.md `device` block
 * @property {object}  capabilities API.md `capabilities` block
 * @property {Array}   profiles     API.md `profiles` array (client-safe)
 * @property {object|null} ptz      API.md `ptz` block
 * @property {Map<string, ProfileInternal>} profileMap  keyed by profile token
 * @property {import('events').EventEmitter} events  ONVIF event bus
 * @property {number}  createdAt
 * @property {number}  lastSeenAt
 * @property {() => void} touch     refresh idle TTL
 */

/**
 * @typedef {Object} ProfileInternal
 * @property {string} token
 * @property {string} name
 * @property {string} rtspUri       ALREADY has credentials injected. Server-side only.
 * @property {string|null} snapshotUri
 * @property {{codec:string,width:number,height:number,fps:number,bitrate:number}} video
 * @property {object|null} audio
 */
```

`sessions.js` exports:

```js
export function createSession(fields)        // -> Session
export function getSession(id)               // -> Session | undefined
export function destroySession(id)           // tears down: streams, events, cam
export function onSessionDestroyed(handler)  // handler(sessionId) — streaming registers here
```

## Error helper

`server/errors.js` (owned by **core**, imported by everyone):

```js
export class AppError extends Error {
  constructor(code, message, hint = null, status = 400)
}
export function toResponse(err)   // -> { status, body: { error: { code, message, hint } } }
```
Codes are the closed set listed in `API.md`.

---

## Streaming module exports

`server/stream/pipeline.js` (owned by **streaming**):

```js
/**
 * Spawns ffmpeg for a profile's RTSP URI and returns a live handle.
 * @returns {Promise<StreamInfo>} StreamInfo = { streamId, transcoding, codec, mime, width, height, fps }
 */
export async function startStream(session, profileToken)

export function stopStream(streamId)          // idempotent
export function getStream(streamId)           // -> StreamHandle | undefined
export function stopAllForSession(sessionId)  // called on session destroy

/**
 * StreamHandle extends EventEmitter and carries:
 *   .streamId  .mime  .info
 *   .initSegment : Buffer|null   ftyp+moov, replayed to late subscribers
 * Events:
 *   'init'      (Buffer)  init segment ready
 *   'fragment'  (Buffer)  moof+mdat
 *   'stats'     ({ bitrateKbps, fps, droppedFrames })
 *   'degraded'  ({ reason, fallback })
 *   'error'     ({ code, message })
 *   'close'     ()
 */
```

`server/stream/ws.js` (owned by **streaming**):

```js
// Called by server/index.js after it has routed the upgrade by pathname.
export function handleStreamSocket(ws, url /* URL */, ctx)
// ctx = { getSession, pipeline }
```

`server/stream/snapshot.js` (owned by **streaming**):

```js
export async function fetchSnapshot(session, profileToken)
// -> { contentType: string, body: Buffer }   throws AppError on failure
```

**Core** calls these from `routes/media.js` for `/stream/start`, `/stream/stop`
and `/snapshot`. Streaming does **not** register any express routes itself.

## WebSocket upgrade routing

`server/index.js` (**core**) owns the single `WebSocketServer({ noServer: true })`
and routes by pathname:

```js
if (url.pathname === '/ws/stream') handleStreamSocket(ws, url, ctx);
else if (url.pathname === '/ws/events') handleEventsSocket(ws, url, ctx);
else ws.close(4004, 'Unknown endpoint');
```

Streaming must not call `server.on('upgrade')`.

---

## Frontend module exports

`public/js/player.js` (owned by **streaming**) — self-contained, uses `fetch` and
`WebSocket` directly. **It must not import `api.js`**, to keep the two work
streams independent.

```js
/**
 * @param {{ video: HTMLVideoElement, sessionId: string }} opts
 * @returns {Player}
 * Player = {
 *   start(profileToken): Promise<void>,   // calls /stream/start then opens /ws/stream
 *   stop(): void,
 *   destroy(): void,
 *   on(event, cb): () => void,            // returns an unsubscribe function
 *   getState(): 'idle'|'connecting'|'playing'|'reconnecting'|'degraded'|'error'
 * }
 * Emitted events:
 *   'state'    (state, detail?)
 *   'stats'    ({ bitrateKbps, fps, droppedFrames, latencyMs })
 *   'degraded' ({ reason, fallback })
 *   'error'    ({ code, message })
 */
export function createPlayer({ video, sessionId })
```

The **frontend** owner constructs the `<video>` element and calls
`createPlayer(...)`; it never reaches into MSE itself.

`public/index.html` (owned by **frontend**) must include, in `<head>`:

```html
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/app.css">
<link rel="stylesheet" href="/styles/player.css">
<script type="module" src="/js/app.js"></script>
```

`player.css` is created by **streaming** and styles only the video surface,
its state overlays, and the degraded-mode badge — using the CSS custom
properties defined in `tokens.css` (`--surface`, `--text`, `--accent`,
`--radius-lg`, `--blur`), never hardcoded colors.
