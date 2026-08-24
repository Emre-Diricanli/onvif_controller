# ONVIF Controller

Local web app: enter a camera IP and credentials, get a live stream plus a full
ONVIF control surface (PTZ, presets, imaging, events, device).

## Requirements
- Node.js 20+
- `ffmpeg` on `$PATH` (or set `FFMPEG_PATH`)

## Run
```
npm install
npm start
```
Then open http://localhost:8080

See `SPEC.md` for the design contract and `API.md` for the wire protocol.
