# Multi-channel devices — the contract

The app currently assumes one device is one camera. That holds for an IP camera
and breaks for a DVR or NVR, where a single ONVIF endpoint fronts many sensors.

**This file is frozen.** All three work streams build against it.

---

## The confusion to remove

Two concepts are fused today, and a recorder splits them:

| Concept | On an IP camera | On a DVR / NVR |
| --- | --- | --- |
| **Device** — what you connect to | the camera | the recorder |
| **Source** — what a setting applies to | the one sensor | one of N channels |

`GetVideoSources` returns one entry per sensor. A media profile names the source
it belongs to via `videoSourceConfiguration.sourceToken`. So a 16-channel
recorder typically reports 16 sources and ~32 profiles (main + sub per channel).

**Per-source settings:** imaging, PTZ, video encoder, snapshot, the live stream.
**Per-device settings:** network, hostname, NTP, time sync, reboot, relay outputs.

Getting that split wrong is not cosmetic. Applying a "device" setting from a
channel-scoped view lets an operator re-IP an entire recorder while believing
they are adjusting one camera.

## The chosen approach — adaptive (option C)

- **One source → render exactly today's UI.** No channel picker, no extra click,
  no behavioural change. This is the overwhelmingly common case and must not
  regress.
- **Many sources → a channel-scoped layout.** The operator selects a channel;
  per-source sections act on that channel and say so. Device-wide sections are
  visually separated and labelled as applying to the whole recorder.

This follows the capability-driven principle already in `SPEC.md` §4: adapt to
what the device actually reports, rather than showing controls that do not fit.

## Two latent bugs this must fix

Both are harmless on a single-source camera and dangerous on a recorder. They
are the reason this work is worth doing carefully.

**1. `sourceTokenFor()` in `server/onvif/imaging.js`** falls back to
`real[0]` when a profile's claimed source token does not validate. On a
recorder that silently means **channel 1** — so adjusting brightness on channel
7 changes channel 1 instead, and the write genuinely succeeds, so the read-back
verification confirms it. The operator is told it worked.

**2. `requireProfile()` in `server/sessions.js`** defaults an omitted profile
to `session.profiles[0]`. On a recorder that is **channel 1**, so a PTZ move or
encoder change with no explicit profile aims at the wrong camera.

On a multi-source device both must **refuse rather than guess**, with an error
that says a channel is required. Guessing is worse than failing here.

## Session shape

`connectDevice()` must additionally resolve the device's video sources and group
profiles by source. Add to the session and to the `/api/connect` payload:

```json
{
  "isMultiChannel": true,
  "sources": [
    {
      "token": "VideoSource_1",
      "label": "Channel 1",
      "profiles": [
        { "token": "Profile_1", "name": "mainStream", "video": { "...": "..." } },
        { "token": "Profile_2", "name": "subStream",  "video": { "...": "..." } }
      ],
      "ptzSupported": true,
      "imagingSupported": true
    }
  ]
}
```

Rules:

- `isMultiChannel` is `sources.length > 1`. A single-source device still reports
  a `sources` array of one, so clients have a single code path.
- `label` prefers a device-supplied name; fall back to `Channel N` by index.
  Never invent a name that implies knowledge the device did not give.
- `ptzSupported` / `imagingSupported` are **per source**, not per device. Some
  recorders expose PTZ on a few channels only, and a channel with no PTZ must
  not render a joystick.
- The existing top-level `profiles` array stays, unchanged, for compatibility.

## API

Per-source endpoints keep taking `profile`, which already implies the source —
no signature changes. What changes is that on a multi-source device the profile
becomes **required** rather than defaulted.

Device-wide endpoints (`/device`, `/device/network`, `/device/reboot`,
`/device/synctime`, `/device/relay`) are unchanged and must never be presented
as channel-scoped.

## Non-goals

- Do **not** attempt to reach a channel's underlying camera at its own IP. That
  is a separate, larger feature and may not be routable.
- Do **not** build a multi-channel live grid. N channels means N ffmpeg
  transcodes; one live stream at a time stays the rule.
- Do **not** add per-channel recording, playback, or Profile G.
