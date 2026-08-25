# Event fan-out — webhooks and snapshots

Today the ONVIF event pipeline terminates in a browser panel: one human, on one
laptop, watching one camera. The subscription machinery is the hardest-won code
in the project (`server/onvif/events.js` — resubscribe, backoff, and the
`guardUnsubscribe` fix for a library that throws synchronously from its own
error path and kills the process). All of that value evaporates when the tab
closes.

This iteration turns those events into signed HTTP messages the edge stack can
consume.

**This file is frozen.** All three work streams build against it.

---

## Shape

A session with fan-out configured POSTs every event to one or more operator-
configured URLs:

```
POST https://edge.spacture/hooks/onvif
Content-Type: application/json
X-Onvif-Event-Id: 019bf3a2-...
X-Onvif-Timestamp: 1756134121
X-Onvif-Signature: sha256=<hex>

{
  "id": "019bf3a2-...",
  "source": { "host": "192.168.12.129", "port": 80, "channel": "VideoSource_7", "label": "Channel 7", "profile": "Profile_13" },
  "device": { "manufacturer": "UNIX", "model": "IPM32R32P", "serial": "00:09:1B:2F:16:2F" },
  "topic": "tns1:RuleEngine/CellMotionDetector/Motion",
  "class": "motion",
  "state": true,
  "eventTime": "2026-08-25T15:22:01.000Z",
  "receivedAt": "2026-08-25T15:22:01.184Z",
  "data": { "IsMotion": true },
  "snapshot": null
}
```

### Identity is mandatory

A webhook from "whatever camera is currently connected in some browser session"
is not a fleet integration. Every event carries `source` and `device` so a
downstream system can route, deduplicate, and diagnose it without asking us.
`channel` is the video source token, resolved the same way `CHANNELS.md`
requires — never guessed from ordering.

### Classes

Normalize the vendor topic into a stable class, and **always keep the original
topic and data**. Normalization must never destroy the vendor evidence:

`motion`, `human`, `vehicle`, `tamper`, `line_crossing`, `field_detect`,
`audio`, `input`, `other`.

An unrecognized topic is `other` — never force it into a class that seems close.

## Signing

HMAC-SHA256 over the exact bytes of the request body, keyed by a per-target
secret. Header is `X-Onvif-Signature: sha256=<lowercase hex>`.

The signed payload must include `id` and a timestamp so a receiver can reject
replays. Document verification in one short snippet in the README so the
receiving end is unambiguous.

The secret comes from config and is **never** logged, never returned by an API
endpoint, and never sent to the browser — same rule as camera passwords in
`SPEC.md` §8. An API that reads back a target must show the URL and whether a
secret is set, not the secret itself.

## Delivery semantics

**At-least-once, bounded, and lossy under pressure — by design.** A camera in a
motion storm must never be able to exhaust memory or wedge the app.

- Bounded queue per target (default 100). When full, **drop the oldest and
  count it**. Never grow without limit, never block the event loop.
- Bounded concurrency per target (default 4 in flight).
- Retry on connection failure and 5xx: 3 attempts, exponential backoff with
  jitter. **Never retry a 4xx** — the receiver rejected it on purpose.
- Per-target circuit breaker: after N consecutive failures, open the circuit for
  a cooldown and drop-with-counter instead of hammering a down endpoint. Your
  VLANs are flaky and a retry storm against a dead edge box is its own outage.
- A hard per-request timeout. A hung receiver must not pin a slot forever.
- Every drop, retry, and breaker trip is counted and readable through a stats
  endpoint. Silent loss is not acceptable; counted loss is fine.

## Snapshots

Optional per target, and **off by default**. When enabled with a topic filter,
attach a JPEG fetched through the existing `server/stream/snapshot.js` path.

- Rate-limit and coalesce: a burst of motion events must not launch dozens of
  JPEG fetches. One in flight per channel, with a minimum interval.
- A snapshot failure must **never** suppress the event. Send the event with
  `snapshot: null` and a `snapshotError` string.
- Default delivery is a URL-free inline base64 field only if the operator opted
  in; otherwise omit. Images may contain people — do not attach by default.

## SSRF

This feature makes the app issue outbound HTTP to an operator-supplied URL.
That is a real SSRF primitive, so:

- `http:` and `https:` only.
- Reuse the **existing** SSRF denylist from `server/onvif/network.js` /
  wherever the connect path already blocks cloud metadata and link-local. Do not
  write a second, divergent copy.
- RFC1918 stays **allowed** — the entire point is posting to `192.168.x` and
  `10.x` edge boxes. This matches the existing documented posture.
- Resolve-then-check is not required, but the denylist must be applied to the
  configured URL at configuration time and reported clearly if rejected.

## Configuration

Targets are configured server-side, not by the browser: a JSON file path via
env, plus API endpoints to list and test. Credentials rule from `SPEC.md` §8
still holds — **camera passwords never touch disk.** A webhook secret is not a
camera password and may live in the config file, but it must be `0600` and
never logged.

Minimum API:

- `GET /api/fanout` — targets (URL, enabled, filters, `hasSecret`, stats). No secrets.
- `POST /api/fanout/test` — send a synthetic event to one target and report the
  real HTTP status. This is the single most useful debugging affordance; build it.

## Lifetime — say what is true

Fan-out lives as long as the **session**, not the browser tab. If the operator
disconnects, delivery stops. That is a real limitation and the README must say
so plainly rather than implying a headless bridge. A durable subscriber is a
later, separate piece of work and is explicitly out of scope here.

## Non-goals

- No MQTT, Kafka, or broker dependency. Node's `fetch` and `crypto` only.
- No persistence of delivered events. This is a bridge, not a store.
- No recording, no playback.
- No new npm dependency, no build step, no framework — `SPEC.md` §1 stands.

## Definition of done

- Events reach a target with a verifiable signature.
- A motion storm drops rather than grows; drops are counted and visible.
- A dead target trips the breaker and the app stays responsive.
- A snapshot failure still delivers the event.
- No secret appears in any log, API response, or browser payload.
- Smoke tests cover: signature correctness, retry on 5xx, no retry on 4xx,
  queue overflow drop-oldest, breaker open/close, snapshot failure isolation,
  and SSRF rejection.
