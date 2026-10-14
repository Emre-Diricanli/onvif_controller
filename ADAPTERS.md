# Device adapters — the contract

The goal of this app is a **universal way to read and change a setting on an IP
camera or an NVR/DVR**, over whatever API the device actually answers:
ONVIF, Hikvision ISAPI, Dahua CGI, Axis VAPIX, Reolink, Uniview, and so on.
ONVIF is one adapter among several. It is not a gateway that every device must
pass through.

This builds on two lessons the repo already learned the hard way:

- **A device's "OK" proves nothing.** Every write is confirmed by reading the
  value back (VENDOR.md; the Vatilon and Hikvision imaging stubs).
- **A recorder is a scarce resource.** Every byte sent to a device goes through
  the per-host governor (GOVERNOR.md; the AR504-32 wedge).

**This file is frozen.** Four work streams build against it in parallel. If you
need it to change, say so in your commit message; do not edit it.

---

## 1. Ownership

| Stream | Owns (exclusive) |
| --- | --- |
| 1 Kernel / API / UI | `ADAPTERS.md`, `API.md`, `package.json`, `server/settings/**`, `server/adapters/index.js`, `server/adapters/onvif/**`, `server/onvif/**` *except* `http-digest.js`, `server/routes/**`, `server/sessions.js`, `server/index.js`, `public/**`, `tools/run-tests.mjs`, `tools/adapter-harness.mjs`, `tools/smoke.mjs`, `tools/personas/index.js`, `tools/tests/kernel*.mjs`, `tools/tests/harness-selftest.mjs` |
| 2 Transport & locks | `server/transport/**`, `server/onvif/http-digest.js`, `tools/tests/transport*.mjs` |
| 3 Hikvision + Dahua/Lorex | `server/adapters/hikvision/**`, `server/adapters/dahua/**`, new `tools/personas/{hikvision,dahua,lorex}-*.js` (NOT the existing `dahua-xvr.js`), `tools/tests/{hikvision,dahua}*.mjs`, `tools/probe-isapi.mjs`, `tools/probe-dahua.mjs` |
| 4 Axis + Reolink + Uniview | `server/adapters/{axis,reolink,uniview}/**`, `tools/personas/{axis,reolink,uniview}-*.js`, `tools/tests/{axis,reolink,uniview}*.mjs` |

**Frozen for everyone during this effort:** `server/device/governor.js`,
`server/vendor/**` (Vatilon moves into `server/adapters/` only after two native
adapters have landed), `server/errors.js`, every existing file under
`tools/personas/` except `index.js`, and `tools/mock-*.js`.

Do not edit a file you do not own. If you need a change in someone else's file,
say so in your commit message.

---

## 2. Vocabulary

- **Device**: one network endpoint (host + port) with one set of credentials.
- **Target**: an addressable thing on the device that settings belong to.
  `{ id, scope, label, channel?, parent? }`
  - `scope` is one of `device | channel | source | stream`.
    - `device`: system-wide settings (time, network, OSD defaults).
    - `channel`: one camera input on a recorder, or the single input on a camera.
    - `source`: a physical sensor (imaging lives here on ONVIF).
    - `stream`: one encoded stream (main, sub, third) belonging to a channel.
  - `id` is **opaque**. Only the adapter that issued it interprets it.
    Suggested form: `<scope>:<native-id>`, e.g. `channel:1`, `stream:101`.
  - `channel` is the 1-based number shown to an operator. It is a label, not an
    address. Hikvision's `101` and Dahua's `0` both have `channel: 1`.
  - `parent` is the id of the containing target (a stream's channel).
  - **A profile token is not a channel.** Never infer that two targets are the
    same thing from matching numbers across protocols. If a mapping is
    ambiguous, refuse it (`UNSUPPORTED`). Do not guess.
- **Descriptor**: what one setting on one target looks like on *this* device.
- **Resource**: the native configuration object a setting is stored in (for
  example `/ISAPI/Image/channels/1/color`). Two settings in the same resource
  are written together. Locks are taken per resource.

---

## 3. Descriptors

Descriptors are **declared by the device**, never hard-coded per vendor into
the UI.

```js
{
  key: 'image.brightness',      // canonical key (§4) or 'vendor.<adapterId>.<name>'
  label: 'Brightness',
  group: 'imaging',             // imaging | encoder | osd | network | time | system | ptz | other
  type: 'int',                  // int | number | enum | bool | string
  unit: null,                   // e.g. 'kbps', 'fps', 's', '%' — null when dimensionless
  min: 0, max: 100, step: 1,    // int/number only; omit when the device gives no range
  values: undefined,            // enum only: array of allowed native values (strings)
  writable: true,               // false if the device or this adapter cannot write it
  resource: 'image/color/1',    // native config object; the lock key (§7)
}
```

- **Native units and native ranges.** Do not rescale to 0..100. If Vatilon is
  0..255 and Hikvision is 0..100, the descriptors say so and the UI follows
  `min`/`max`. Rescale only when the conversion is exact and documented
  (for example the device speaks bps and the canonical unit is kbps).
- Only declare `min`/`max`/`values` when the **device** reported them, or the
  vendor documents them as fixed. A guessed range is worse than none.
- Enum `values` are the adapter's **canonical** strings where §4 defines them,
  mapped from native in the adapter.
- A setting the adapter can read but not write is `writable: false`. Never
  advertise a field as writable that has not been seen to change on read-back,
  at least against the persona.

---

## 4. Canonical keys (Milestone 1)

Use the canonical key whenever the semantics match exactly. Otherwise use
`vendor.<adapterId>.<nativeName>`. Do not invent new canonical keys; propose
them in a commit message.

### Imaging (target scope `channel` or `source`)

| key | type | notes |
| --- | --- | --- |
| `image.brightness` | int/number | native range |
| `image.contrast` | int/number | native range |
| `image.saturation` | int/number | native range |
| `image.sharpness` | int/number | native range |
| `image.dayNight` | enum | `auto` \| `day` \| `night` (add `schedule` only if the device has it) |
| `image.wdr` | bool | wide dynamic range on/off |
| `image.wdrLevel` | int | native range |
| `image.blc` | bool | backlight compensation on/off |
| `image.mirror` | bool | horizontal flip |
| `image.flip` | bool | vertical flip |
| `image.irLight` | enum | `auto` \| `on` \| `off` |

### Encoder (target scope `stream`)

| key | type | notes |
| --- | --- | --- |
| `video.codec` | enum | `H.264` \| `H.265` \| `MJPEG` (+ native extras as `vendor.*`) |
| `video.resolution` | enum | `"<width>x<height>"`, e.g. `"1920x1080"`; `values` = device's list |
| `video.fps` | number | unit `fps` |
| `video.bitrateMode` | enum | `cbr` \| `vbr` |
| `video.bitrate` | int | unit `kbps`; for VBR, the cap |
| `video.gop` | int | I-frame interval in frames |
| `video.profile` | enum | `baseline` \| `main` \| `high` (H.264 profile) |

---

## 5. The adapter module

Each adapter lives at `server/adapters/<id>/index.js`. The registry finds it
automatically (§9), so you never need to edit a shared file to register one.

```js
export const id = 'hikvision';          // /^[a-z][a-z0-9-]*$/, equals the directory name
export const label = 'Hikvision ISAPI';
export const priority = 20;             // probe order, lower first; ONVIF is 100
export const defaultPorts = [80];       // HTTP ports to try when the operator gave none

/**
 * Cheap, read-only, and never throws. Every failure collapses to { match: false }.
 * It must recognize the vendor by CONTENT (a vendor-specific path AND body
 * shape), not by a 200 status. A Dahua box must not match the Hikvision probe.
 * It sends at most 3 requests.
 */
export async function probe(config) -> { match: boolean, confidence: 0..1, model?, firmware? }

/** Authenticates. Throws AppError: UNAUTHORIZED, DEVICE_UNREACHABLE, DEVICE_TIMEOUT, DEVICE_ERROR. */
export async function connect(config) -> Connection
```

`config` is `{ host, port, username, password, timeoutMs, scheme? = 'http' }`.

### Connection

```js
{
  id, label,                                 // the adapter's
  info: { vendor, model, firmware, serial }, // null where unknown
  async listTargets()            -> Target[]
  async describeSettings(targetId) -> Descriptor[]
  async read(targetId, keys?)    -> { values: { [key]: value }, source: id }
  async write(targetId, patch)   -> WriteResult   (§6)
  close()                        // idempotent, never throws
}
```

- `read` with no `keys` returns every readable described key.
- An unknown `targetId` throws `AppError('NOT_FOUND')`.
- A `patch` key that is not described, not writable, the wrong type, or out of
  range throws `AppError('BAD_REQUEST')` **before anything is sent**. Use
  `validatePatch()` from `server/settings/contract.js`.
- The adapter caches whatever it learned in `listTargets`/`describeSettings`
  (capabilities and option lists) for the life of the connection. It must not
  re-probe on every read.

---

## 6. Writes: read-modify-write, verify, report per field

Every adapter `write` follows the same sequence. `server/settings/contract.js`
implements the shared parts. Use it rather than re-deriving the rules.

1. `validatePatch(patch, descriptors)`. Invalid input never reaches the wire.
2. Group the patch by `resource`. For each resource, under
   `withResourceLock(lockKey(host, port, resource), fn)` (§7):
   1. GET the **current** native object.
   2. Change **only** the requested fields. Never send a value the operator
      did not ask for, other than the unchanged remainder of an object the
      device requires to be sent whole.
   3. PUT/POST it.
   4. If the device explicitly refuses (an error status, or a vendor error body
      naming the field), that field is `rejected`. Do not throw for a per-field
      refusal; throw only when the whole request failed at the transport level.
3. Verify with `verifyWrite()`: it polls the read-back on
   `READBACK_DELAYS_MS` (`[150, 400, 900]`) until every field is `applied`, or
   the schedule runs out.
4. Return:

```js
{
  source: 'hikvision',
  results: {
    'image.brightness': { outcome: 'applied', requested: 70, observed: 70 },
    'image.contrast':   { outcome: 'adjusted', requested: 101, observed: 100 },
  },
  values: { ...the read-back values of the patched keys }
}
```

`outcome` is exactly one of:

| outcome | meaning |
| --- | --- |
| `applied` | read-back equals what was requested |
| `adjusted` | read-back changed, but to something else (clamped or quantized) |
| `unchanged` | read-back still equals the old value; the device ignored the write |
| `rejected` | the device explicitly refused this field |
| `unknown` | the write was sent, but the outcome could not be confirmed (read-back failed or timed out) |

### Fallback rules (non-negotiable)

- **Never automatically replay a write through another adapter after a
  timeout, a transport error, or `unknown`.** The first write may still land,
  and replaying it produces a double write. Report `unknown` and stop.
- The **only** automatic cross-adapter fallback is the existing stub rule:
  every field in the write came back `unchanged` after the full read-back
  schedule (`looksLikeOnvifStub`). The kernel decides this, not the adapter.
- Adapters never call other adapters.

---

## 7. Transport, governor, and locks

**No adapter opens a socket itself.** No `fetch`, no `http.request`. All
traffic goes through `server/transport/http.js`. That client wraps every
exchange (including a digest challenge round-trip) in `withGovernor(host)`.
This is the AR504-32 rule: four new adapters probing one recorder is exactly
how the wedge happened.

```js
import { createHttpClient } from '../../transport/http.js';

const client = createHttpClient({
  host, port, scheme = 'http',
  username, password,
  auth = 'auto',          // 'auto' | 'digest' | 'basic' | 'none'
  timeoutMs = 8000,       // per exchange
  maxBodyBytes = 4 MiB,   // a larger body is DEVICE_ERROR, never buffered unbounded
  insecureTls = false,    // https only: accept a self-signed cert; explicit operator opt-in, never a default
});

const res = await client.request({
  method = 'GET', path,   // path includes the query string
  headers = {}, body,     // body: string | Buffer | object (an object is sent as JSON)
  timeoutMs, priority,    // priority: governor PRIORITY.* (default normal)
});
// res: { status, headers, text, json() }   json() throws DEVICE_ERROR on bad JSON
client.close();
```

- `auth: 'auto'` answers whatever challenge the device sends: RFC 2617 Digest
  (MD5 and MD5-sess, qop=auth, incrementing nc), or Basic **only if the device
  asks for Basic**. `'none'` is for adapters that do their own login (Reolink
  tokens, Dahua RPC2 sessions) and put the credential in the body or query.
- A non-2xx status is **returned**, not thrown, so the adapter can read a
  vendor error body. The exceptions:
  - 401 after the auth retry throws `AppError('UNAUTHORIZED')`
  - a connection failure throws `DEVICE_UNREACHABLE`
  - a timeout throws `DEVICE_TIMEOUT`
  - the governor refusing to send throws `DEVICE_BUSY`
- The client never logs, and never puts in an error message, the password, the
  `Authorization` header, or a token-bearing query string.

```js
import { withResourceLock, lockKey } from '../../transport/lock.js';
await withResourceLock(lockKey(host, port, resource), async () => { /* GET, modify, PUT, verify */ });
```

The lock is **not** a governor slot. Hold the lock while awaiting governed
requests, never the other way around. It serializes read-modify-write per
`(device, resource)` across every session and every adapter in this process.

---

## 8. Tests and personas

**Vendor personas are HTTP handlers.** They use the same shape as the existing
ONVIF personas, so one module serves both the standalone harness and
`MOCK_PERSONA=<name> node tools/mock-camera.js`:

```js
// tools/personas/hikvision-ds2cd.js
export const persona = {
  name: 'hikvision-ds2cd',      // equals the file name
  vendor: 'hikvision',          // the adapter id this persona impersonates
  create(ctx) {                 // ctx: { HOST, PORT, mode, username, password, callCounts }
    return {
      onRequest(req, res) {     // return true when handled; false lets it fall through (404)
        ...
      },
    };
  },
};
```

- `ctx.mode` must support at least:
  - `default`: writes land and read back.
  - `ignore`: writes return success and change nothing (the stub signature).
- The persona enforces the vendor's real auth (Digest/Basic/token) for the
  harness credentials, and answers 401 to anything else.
- The persona is **strict where the real device is strict**: request shapes,
  status codes, error bodies. Document each quirk with where it was observed,
  or mark it `// assumed from vendor docs, not hardware-verified`.

**Tests** live in `tools/tests/<name>.mjs` and are discovered by
`tools/run-tests.mjs` (files starting with `_` are skipped). A test exits
non-zero on failure. Use `tools/adapter-harness.mjs`:

```js
import { createChecker, runConformance } from '../adapter-harness.mjs';
import * as adapter from '../../server/adapters/hikvision/index.js';
import { persona } from '../personas/hikvision-ds2cd.js';

const t = createChecker('hikvision');
await runConformance(t, { adapter, persona, sample: { scope: 'channel', key: 'image.brightness', value: 70 } });
// ...adapter-specific checks with t.check(name, ok, detail)...
t.done();
```

`runConformance` checks the following:
- the module's shape
- a probe match against the persona
- no probe match, and no throw, against a closed port and against a plain 404 server
- connect
- the shape of targets and descriptors
- read
- an applied write
- `BAD_REQUEST` for an unknown key and for an out-of-range value
- `unchanged` in `ignore` mode
- `UNAUTHORIZED` for a wrong password
- that traffic went through the governor

A conformance pass makes a driver **mock-verified**. Each adapter's
`index.js` header states its verification level:
`// Verification: mock-verified (persona X)` or
`// Verification: device-verified (<model>, firmware <v>, <date>)`.

---

## 9. Registry

`server/adapters/index.js` discovers `server/adapters/*/index.js` at startup and
orders the adapters by `priority`. It exposes:

```js
listAdapters()                     -> adapter modules
getAdapter(id)                     -> module | null
probeAll(config, { only? })        -> [{ id, match, confidence, model?, firmware? }]  // serial, governed, cached per host for 60s
```

Probes run **one at a time** (never in parallel) against a host, and the result
is cached per `host:port`, so a connect never storms a recorder.

---

## 10. Invariants, inherited from SPEC.md, VENDOR.md, and GOVERNOR.md

- Credentials never touch disk, and are never logged at any level.
- No new npm dependencies. Node's `crypto`/`http`/`https` only.
- Every response says which `source` (adapter id) produced it.
- Never apply a value the operator did not ask for.
- A broken vendor API degrades to an honest error or `unknown`, never to a
  crash, and never to a false `applied`.
- The existing 336 smoke checks stay green. All of this work is additive.
