# Video encoder configuration — the contract

Change a camera's resolution, framerate, bitrate and codec via ONVIF
`SetVideoEncoderConfiguration`.

**This file is frozen.** All three work streams build against it.

## Verified on real hardware

Probed against the operator's Vatilon "Sinis 5MP IPC", firmware V1.16.39:

```
[MainStreamToken] MainStream — H265 2880x1616 @30fps 4096kbps
  H264/H265 resolutions: 2880x1616, 2560x1440, 2304x1296, 1920x1080, 1280x720
  fps 1-30
[SubStreamToken]  SubStream  — H265 640x480 @30fps 512kbps
  H264/H265 resolutions: 704x576, 800x448, 640x480, 640x360, 352x288
  fps 1-30
```

Two things this establishes:

1. **Encoder writes actually work on this camera.** SubStream was changed
   640x480 -> 352x288 and read back applied, then restored. Unlike the Imaging
   service, this is not a stub — so no vendor fallback is needed here.
2. **Resolution sets are per-profile and disjoint.** The main stream cannot be
   set to 352x288 and the sub stream cannot be set to 2880x1616. Never present a
   single shared list; always use the options for the profile being edited.

## Ownership

| Area | Owner |
| --- | --- |
| `server/onvif/encoder.js`, `server/routes/media.js` | backend |
| `public/js/views/encoder.js`, `public/styles/encoder.css` | frontend |
| `server/stream/pipeline.js`, `public/js/views/controller.js`, `public/index.html`, `tools/mock-camera.js`, `tools/smoke.mjs`, `API.md` | orchestration |

Do not edit a file you do not own.

## API

### `GET /api/session/:id/encoder?profile=<token>`

```json
{
  "current": {
    "token": "VideoEncoder", "name": "MainStream", "encoding": "H265",
    "width": 2880, "height": 1616, "fps": 30, "bitrateKbps": 4096,
    "govLength": 50, "quality": 4
  },
  "options": {
    "encodings": ["H264", "H265"],
    "resolutions": { "H264": [{ "width": 2880, "height": 1616 }], "H265": [] },
    "fps":     { "min": 1, "max": 30 },
    "bitrate": { "min": 256, "max": 8192 },
    "govLength":{ "min": 1, "max": 100 },
    "quality": { "min": 1, "max": 6 }
  }
}
```

Any `options` key may be absent when the device does not report it. The UI
renders only what is present and NEVER hardcodes a resolution list.

### `PATCH /api/session/:id/encoder`

```json
{ "profile": "MainStreamToken",
  "settings": { "encoding": "H265", "width": 1920, "height": 1080, "fps": 20, "bitrateKbps": 2048 } }
```

Partial update. Returns the same shape as `GET`, plus:

```json
{ "applied": { "width": true, "height": true, "fps": true },
  "streamRestartRequired": true }
```

`applied` is computed from a **read-back**, never from the SOAP status — the
same rule the imaging path already follows. Reject any value not present in the
device-reported options with `BAD_REQUEST` before sending anything.

`streamRestartRequired` is true whenever the change affects a profile that has a
live stream, which the orchestration layer uses to rebuild the pipeline.

## Restart semantics

Changing the encoder of a profile that is currently streaming invalidates both
the running ffmpeg process and the browser's MSE SourceBuffer: the resolution
and codec in the init segment no longer match the incoming fragments, and the
video freezes on the last frame while the socket still looks healthy.

The orchestration layer owns this. Backend and frontend must not attempt their
own restart; just report and honour `streamRestartRequired`.
