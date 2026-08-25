# Recorded video playback (ONVIF Profile G) — the probe

The app is live-only. A DVR/NVR also holds the past, and reaching it is ONVIF
Profile G. This iteration builds **a probe, not a player.**

**This file is frozen.** All three work streams build against it.

---

## Why a probe first

We have no device we can confirm supports Profile G:

- The Vatilon camera reported **no recording service at all**.
- `10.1.10.70` (CMS OEM DVR) **rejects every ONVIF auth scheme** we have tried,
  so we cannot ask it anything.
- `10.1.10.50` / `.60` expose **no ONVIF endpoint**.

Every real bug in this project — the imaging stub, the stale profile cache, the
wrong-channel write, the crash in the events loop — was found on hardware and
none by reasoning about the spec. Building a timeline scrubber before knowing
whether `GetReplayUri` returns anything would repeat that mistake at a much
larger scale.

So iteration 1 answers one question per device: **what can this recorder
actually do, and what exactly does it return?** Iteration 2 builds the player
against real captured evidence.

## What the library gives us, and what it does not

Verified by reading `node_modules/onvif/lib`:

| Service | Namespace | Library support |
| --- | --- | --- |
| Recording | `ver10/recording/wsdl` | `getRecordings`, `getRecordingSummary`, `getRecordingInformation`, `getRecordingOptions`, `getRecordingServiceCapabilities`, `getTrackConfiguration`, … |
| Replay | `ver10/replay/wsdl` | `getReplayUri` only |
| **Search** | `ver10/search/wsdl` | **absent — there is no `search.js`** |

The Search service is where the timeline data lives: `FindRecordings`,
`FindEvents`, `GetRecordingSearchResults`, `GetEventSearchResults`. All of it
must go through raw SOAP, the same way `server/onvif/imaging.js` already builds
`SetImagingSettings` by hand.

Two library details that matter:

- `cam._request({ service, body })` resolves `service` against `cam.uri[key]`,
  where the key is the **last path segment of the service namespace** — so a
  device advertising `ver10/search/wsdl` populates `cam.uri.search`. If the key
  is missing, the library treats the string as a literal request path, which
  silently sends the search call to the wrong endpoint. **Resolve the XAddr
  explicitly; never rely on the fallback.**
- `cam.js:618` invents a recording URL by string-replacing `replay` with
  `recording` in the replay XAddr when the device did not advertise one. That
  guess may be wrong. If a recording call fails while replay works, report the
  guessed URL as the likely cause rather than as a device fault.

## Non-negotiable: the probe is read-only

The Recording service also contains `CreateRecordingJob`, `DeleteRecording`,
`DeleteRecordingJob`, and `SetRecordingJobMode`. These **delete an operator's
footage** and are the single most destructive surface ONVIF exposes.

The probe must **never** call a `Create*`, `Delete*`, or `Set*` method — not
behind a flag, not with a confirmation, not in a "test" path. It issues `Get*`
and `Find*` calls and nothing else. Any code that could mutate recorder state is
out of scope for this iteration and for the tool until the operator asks for it
explicitly.

`GetReplayUri` is a read. `FindRecordings` opens a **search session** on the
device, which is server-side state with a token and a timeout — the probe must
call `EndSearch` for every search it starts, including on the error path, or it
leaks search handles on the recorder.

## Deliverable

`node tools/probe-playback.mjs --host <ip> --port <n> --user <u> --pass <p>`

Credentials come from argv/env, are never written to the report, and never
touch disk — same rule as the app (`SPEC.md` §8). The tool prints a human
summary to stdout and writes a **sanitized JSON evidence bundle** to a path the
operator chooses with `--out`.

The report must be safe to paste into a ticket: no password, no credentialed
RTSP URL, no session or search token. Redact with the existing `redactUri()`.

### What it must establish, in order

1. **Service presence** — which of recording / replay / search the device
   advertises, and the XAddr for each (host-rewritten, per `authorizeUri`'s
   NAT rule). Record whether the recording URL was **advertised or guessed**.
2. **Capabilities** — `GetServiceCapabilities` on each present service. This is
   where a device declares `ReverseReplay`, `SessionTimeout`, and dynamic
   recording support. Capture it verbatim.
3. **Inventory** — `GetRecordings` + `GetRecordingSummary`: how many recordings
   exist, the earliest and latest data, and each recording's track list.
4. **Channel mapping** — the hard part. A recording carries a `Source` with a
   `SourceId`/`Name`; media profiles carry a `videoSourceToken`. **These are
   different namespaces and there is no guarantee they match.** Report both
   sides side by side and state plainly whether a mapping was derivable. Do not
   invent one. This is the same class of bug as the wrong-channel imaging write
   in `CHANNELS.md`, and getting it wrong means showing the operator footage
   from a different camera than the one they selected.
5. **Search** — `FindRecordings` then `GetRecordingSearchResults` over a bounded
   window (default: last 24h, overridable with `--from`/`--to`). Then
   `FindEvents` for the same window to see whether motion/human markers come
   back, since those become the timeline markers in iteration 2. **`EndSearch`
   on every path.**
6. **Replay URI** — `GetReplayUri` for a recording token. Record the URI shape
   **redacted**, and whether the device honored the `RTSP` stream setup.
7. **Seek behavior** — the decisive experiment. Ask ffmpeg to open the replay
   URI at an offset and report whether the device accepts the RTSP
   `Range: clock=...` header, what it answers, and how long the first frame
   takes. This is what determines whether a scrubber is usable or whether every
   seek costs a full ffmpeg restart.

### Honest failure

Every step must degrade to a recorded "not supported" with the device's actual
fault text, and continue. A recorder that lacks Search but has Replay is a real
and useful outcome. A probe that aborts on the first missing service tells us
nothing.

**Never report a capability we did not observe.** If auth fails, say auth
failed — do not infer support from the vendor name. We have already shipped one
bug where the app guessed "Hikvision" from a device that refused to identify
itself, and the operator caught it.

## Mock coverage

`tools/mock-camera.js` must be able to answer the probe, behind a new
`MOCK_PLAYBACK_MODE`:

- `off` (default) — no recording/replay/search services. Today's behavior; the
  probe must report a clean "no Profile G" and exit 0.
- `full` — all three services, 2 recordings across 2 sources, search returns
  results and events.
- `replay-only` — replay but no search service, exercising the degraded path.
- `broken-search` — `FindRecordings` succeeds but `GetRecordingSearchResults`
  faults, exercising the `EndSearch`-on-error path.

Smoke tests assert the probe's JSON for each mode, and assert that **the probe
never issues a mutating call** — the mock counts any `Create*`/`Delete*`/`Set*`
on the recording service and the test fails if the count is not zero.

## Out of scope for this iteration

No UI. No API endpoints. No timeline, scrubber, or export. No recording
control. Nothing merged into the app's request path — the probe is a standalone
tool under `tools/`, exactly like the mock and the ffmpeg shim.
