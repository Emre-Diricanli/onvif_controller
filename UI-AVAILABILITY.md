# Always-visible panels with honest unavailability

Today the sidebar hides any section the device cannot support. That was a
deliberate rule (SPEC.md §4) and it has a real cost: the operator cannot tell
whether a feature is missing because **the device lacks it** or because **the
app never built it**. On a 32-channel recorder with no PTZ and no imaging, the
sidebar silently collapses to almost nothing and looks broken.

This work makes every panel always visible, and makes the unavailable ones say
why.

**This file is frozen.** All three work streams build against it.

---

## The three states

| State | Header | Body |
| --- | --- | --- |
| **Available** | normal, expandable | the working panel |
| **Unavailable** | dimmed, `Unavailable` tag, still expandable | one sentence naming the reason |
| **Unavailable on this channel** | dimmed, `Unavailable` tag | reason naming the channel |

Rules that are not negotiable:

- **Never render a disabled clone of the real control.** No greyed-out sliders,
  no dead joystick, no inert buttons. SPEC.md §4 is explicit that a disabled
  control reads as "the app is broken". The body is replaced by prose, not
  disabled inputs.
- **An unavailable section is still expandable.** The operator must be able to
  read the reason. It starts collapsed.
- **Never fire a request from an unavailable section.** It has no live control
  to fire one, and its `build()` must not run.

## Honest reasons

The reason is the whole point of the feature. It must describe **what was
observed**, never a guess.

Good:
- "This device does not advertise the ONVIF Imaging service."
- "This device reports no PTZ node, so there is nothing to move."
- "Channel 7 reports no PTZ. Other channels on this recorder may still support it."
- "This device advertises no ONVIF Recording, Replay or Search service, so
  recorded playback is not available over ONVIF."

Forbidden:
- "Not supported." — says nothing.
- "Your Hikvision firmware is too old." — we do not know the vendor or the
  firmware at that point. We already shipped and fixed one bug that guessed
  "Hikvision" from a device that refused to identify itself; do not reintroduce
  that class of claim.
- Anything implying the operator can fix it unless the device actually said so.

## Two panels that do not exist yet

Both must appear in the sidebar in **every** session, available or not.

### Playback

Recorded video via ONVIF Profile G. Probed against two CMS OEM recorders and
absent on both, so on your hardware this will render unavailable — that is the
correct and useful outcome, and it is exactly why the panel must be visible.

`server/onvif/playback.js` already exports `probePlayback()`, and the capability
matrix already carries a `recording` flag from `GetServices`. Available means the
device advertises Recording or Replay; the reason otherwise names which services
were absent.

When available, the panel lists recordings with their time spans. **Do not build
a timeline scrubber, seek control, or player in this work** — no device we can
reach supports it, and building a player against a mock is exactly the mistake
the probe was written to prevent.

### Fan-out

Webhook delivery status. This is server-side today with no UI at all, so an
operator cannot see that a webhook target has failed.

**Read-only.** The panel never creates, edits, or deletes a target, because
targets carry HMAC secrets and this app has no authentication — a
browser-editable webhook config would let anything that can reach the port add
an exfiltration target. Configuration stays in the `FANOUT_CONFIG` file.

- Available when at least one target is configured.
- Unavailable reason when none: "No webhook targets are configured. Set
  FANOUT_CONFIG to a JSON file of targets and restart."
- Per target: label/URL, enabled state, delivered / failed / dropped counts,
  queue depth, and **breaker state** — a tripped breaker is the thing an
  operator most needs to see.
- A **Send test event** button per target, calling the existing
  `POST /api/fanout/test`, showing the receiver's real status and elapsed time.
- **Never render a secret.** The API returns `hasSecret`; show "signed" or
  "unsigned", never the value. Assert this in a test.

## Wiring

`GET /api/fanout` and `POST /api/fanout/test` already exist and are mounted.
A new `GET /api/session/:id/playback` is needed for the playback panel; it
must reuse `probePlayback()` and must stay **read-only** — the probe may never
issue a `Create*`, `Delete*` or `Set*` recording call, and that guard already
exists in `playback.js`. Do not weaken it.

## Definition of done

- Every panel appears for every device, in a fixed order.
- An unsupported panel shows a dimmed header, an `Unavailable` tag, and a
  specific reason — with no disabled form controls anywhere inside it.
- Expanding an unavailable panel never issues a request.
- Playback and Fan-out panels exist and behave correctly in both states.
- No secret ever reaches the browser.
- On the UNIX IPM32R32P (32 channels, no PTZ, no imaging, no Profile G) the
  sidebar shows the full panel list with honest reasons rather than a near-empty
  column.
