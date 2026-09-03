# Device governor and device personas — the contract

Two council outcomes, built together because they verify each other: the
governor is the fix, and the personas are how we prove it works without touching
a customer's recorder.

**This file is frozen.** All four work streams build against it.

---

## Why

`192.168.15.101` (AR504-32) **wedged** under repeated probing: ONVIF and RTSP
both stopped answering, ping stopped, TCP kept accepting connections. Hikvision
caps concurrent ONVIF sessions, and nothing in this app bounds how many requests
it makes to one device. Many independent code paths each behaved as if they were
the device's only client.

Separately, the suite is 268 checks against **one** mock, so it agrees with the
code by construction. Roughly **3 of 8** known field-bug classes have a standing
test. Every real bug in this project was found on hardware, never by a test.

## Part 1 — The governor

### One chokepoint, no bypasses

All outbound device traffic passes through a per-host governor. Measured today:

- ~56 call sites route through `callCam`/`tryCam` in `server/onvif/util.js` —
  wrapping that one function covers nearly everything.
- **4 raw `cam._request(...)` sites bypass it**, in `device.js`, `network.js`,
  `imaging.js` and `playback.js`. These are exactly the paths a probe storm
  escapes through. They must route through the governor too.

The governor is keyed by **host**, not by session: two browser sessions pointed
at the same recorder share that recorder's firmware session cap, so a per-session
limit would not prevent the wedge.

### Behavior

- **Bounded concurrency per host.** Default **2** in flight. `media.js` already
  has `PROFILE_DESCRIPTION_CONCURRENCY = 8` for one function; that value is
  tuned for parallel profile reads on a healthy device and must not become the
  global default. The governor's cap is the outer bound.
- **Minimum spacing** between requests to the same host, so a burst of small
  calls cannot become a storm.
- **A queue with deadlines.** A request that waits past its deadline fails with
  an honest `DEVICE_BUSY`, never a silent retry.
- **Priority.** Interactive work (PTZ moves, a stream start) must not queue
  behind a bulk capability walk. PTZ latency is user-visible; a profile refresh
  is not.
- **Circuit breaker per host.** N consecutive timeouts or transport faults opens
  the breaker for a cooldown; while open, requests fail fast with a stated
  reason. Half-open with a single cheap probe, never a flood.

### The wedge signature — detect it explicitly

The observed failure is specific and worth naming: **TCP connects, but both
ONVIF and RTSP time out.** When the governor sees that pattern, mark the host
`wedged`, stop all traffic to it, and tell the operator the device likely needs
a power cycle. Do not keep retrying into it — that is what deepened it.

### Rules

- **Never retry into an open breaker or a wedged host.**
- **Probe once per session, cached.** No background re-probing, ever. Discovery,
  vendor fingerprints and the Profile G probe all count against the same budget.
- **The governor must be observable** — queue depth, in-flight count, breaker
  state — because the UI has to be able to say "device busy, paused 10s" rather
  than appearing to hang.

## Part 2 — Device personas

### The rule

**No field bug is closed until a persona reproduces it.** A persona is written
from *observed* device behavior, never from the spec, and never from what we
wish the device did.

### The six probed devices

Each becomes a persona built only from facts established on hardware:

| Persona | Observed behavior to reproduce |
| --- | --- |
| `ipm32r32p` | 32 channels; no Profile G; events carry the channel in the message's own `Source` item, not a profile token; ~485 motion events/minute |
| `rst08` | ONVIF on a non-default port; `admin` with an **empty password**; no Profile G |
| `ar504` | Full Profile G, 33 recordings; **wedges** under concurrent load — TCP accepts, ONVIF and RTSP stop answering |
| `nr520` | ONVIF administratively **disabled**; vendor HTTP API answers over digest; recording off on every track |
| `dahua-xvr` | ONVIF answers **and** a vendor CGI answers; vendor search returns real recordings |
| `vatilon` | Already exists — ONVIF imaging accepts writes, reports success, changes nothing |

Mark every persona trait with the device it was observed on. A trait nobody
observed does not belong in a persona.

### The eight bug classes — all must have a standing test

Currently ~3 of 8. Target 8 of 8:

1. Imaging write succeeds and changes nothing *(covered)*
2. Wrong-channel write that the read-back also confirms *(covered)*
3. `onvif` library throwing synchronously from its own pull loop *(covered)*
4. WS-Security token dropped when the password is empty *(covered)*
5. **Stale profile cache** — `GetProfiles` reports one resolution while the
   stream delivers another *(missing)*
6. **Event channel in the `Source` item**, not a profile token *(partial)*
7. **Boolean `State` coerced by `Number()` to 0**, losing motion start/stop
   *(one check)*
8. **Service XAddr pinned to the literal string `"undefined"`** *(asserted by
   reading CLI source text — fragile, make it behavioral)*

### Fault mutators

Composable wrappers that apply to any persona, so bug *classes* are tested
rather than one instance each: latency spikes, connection reset mid-response,
HTTP 200 with a non-XML error body, boolean-vs-string fields, missing
namespaces, absent or duplicated `Source` items, a missing XAddr.

## Constraints — unchanged

Node 20, exactly three npm dependencies, no build step, no framework, no CDN.
Personas and the governor add **no** runtime dependency. The existing 268 checks
must still pass: this work is additive, and any behavior change it forces is a
bug in this work, not in the tests.

## Definition of done

- No outbound device request can reach a device without passing the governor —
  including the four raw `_request` sites.
- Concurrency, spacing, breaker and wedge detection are asserted by tests, using
  the mock's existing `/__calls` counters to prove pacing rather than assuming it.
- All eight bug classes have a standing behavioral test.
- The six personas exist, each trait attributed to the device it was seen on.
- The suite still passes, and it is larger than 268.
