# Vendor fallback drivers — the contract

Some cameras expose an ONVIF Imaging service that accepts `SetImagingSettings`,
answers with a success envelope, and then changes nothing. Verified on a Vatilon
"Sinis 5MP IPC" (firmware V1.16.39) against five different SOAP shapes — all
ignored. Those cameras usually *do* have a working proprietary HTTP API, because
their own web UI has to drive the picture somehow.

A vendor driver is a fallback for exactly that case. **ONVIF stays the primary
path.** A driver is only consulted when ONVIF has been observed to accept a write
and not apply it.

**This file is frozen.** All three work streams build against it.

---

## Ownership

| Area | Owner |
| --- | --- |
| `server/vendor/digest.js`, `server/vendor/vatilon.js` | transport |
| `tools/mock-vendor-camera.js`, `tools/smoke.mjs` | mock + tests |
| `server/vendor/index.js`, `server/onvif/imaging.js`, `server/routes/imaging.js`, `public/js/views/imaging.js`, `public/styles/imaging.css`, `API.md` | routing |

Do not edit a file you do not own. If you need a change in someone else's file,
say so in your commit message instead.

---

## The Vatilon protocol, as actually observed

Reverse-engineered from the camera's own JavaScript and confirmed against real
hardware. Do not "improve" these details — each one was necessary to make a
write land.

### 1. Login is a hand-rolled digest

Standard HTTP digest does **not** work. The camera's login page builds the header
itself with hardcoded constants and a deliberately mismatched URI:

```
realm = "CAMERA"
nonce = "b6ef824ee4090bbd124a4ccb39c5333a"      // hardcoded in the page
qop   = "auth"
uri   = "/cgi-bin/web.cgi?mod=account&cmd=check" // NOT the URI being requested

HA1      = md5(username + ":" + realm + ":" + password)
HA2      = md5("GET:" + uri)
response = md5(HA1 + ":" + nonce + ":00000001:" + cnonce + ":" + qop + ":" + HA2)
```

That header is sent on `GET /cgi-bin/web.cgi?mod=session&cmd=login1`.

### 2. The session arrives in a response header

`Session-Id: <token>` on the login response. Every later request carries it as a
request header of the same name. There is a heartbeat (`mod=session&cmd=heartbeat`)
roughly every 9.5s in the web UI; a driver should refresh or re-login rather than
assume the session lives forever.

### 3. Reading

```
GET /cgi-bin/web.cgi?mod=image&cmd=get      (with Session-Id)
```

Returns a flat JSON object: `brightness`, `contrast`, `saturation`, `sharpness`,
`exposure`, `day_night_mode`, `wdr_enable`, `mirror`, `flip`, `rotation`,
`nr_enable`, `mwb_red/blue/green`, and nested `day_begin` / `day_end` objects.
All the scalar picture values observed were `0..255`.

### 4. Writing takes TWO params

This is the part everything else got wrong. The CGI counts parameters and
returns the literal string `param num error` when the count is wrong:

```json
POST /cgi-bin/web.cgi          Content-Type: application/json
{ "mod": "image", "cmd": "set",
  "param":  { "channel": 0 },
  "param2": { ...the COMPLETE image object, with your field changed... } }
```

Success is `{"status":"ok","data":""}`. Sending only the changed field, or only
one param, fails. Read the current object, change one value, send the whole
thing back.

### 5. Error strings are not JSON

`param num error` and `unknown error happened` come back as bare text with a 200
status. Treat any non-JSON body, or a JSON body whose `status` is not `"ok"`, as
a failure.

---

## Driver interface

A driver module exports:

```js
export const id = 'vatilon';          // stable slug
export const label = 'Vatilon / Sinis';

/**
 * Cheap, side-effect-free check that this driver can talk to the device.
 * Must not change any setting. Must resolve false (never throw) on a mismatch.
 * @returns {Promise<boolean>}
 */
export async function probe({ host, port, username, password, timeoutMs })

/**
 * @returns {Promise<VendorSession>}
 * VendorSession = {
 *   id: string,                    // the driver id
 *   getImaging(): Promise<{ settings, options }>,
 *   setImaging(patch): Promise<{ settings, applied }>,
 *   close(): void,
 * }
 */
export async function connect({ host, port, username, password, timeoutMs })
```

`settings`, `options` and `applied` use the SAME shapes and the SAME normalized
field names as `API.md`'s imaging endpoints, so the routing layer can return a
driver's output unchanged. In particular the vendor's `saturation` maps to
`colorSaturation`. Only report a field in `options` when a real range is known.

`applied` maps each patched field to `true`/`false` based on a **read-back**,
never on the HTTP status. A camera that answers "ok" and changes nothing must
report `false` — that is the entire reason this contract exists.

Errors throw `AppError` from `../errors.js` with the codes already used in
`API.md`.

---

## Routing rules

Owned by the routing layer; stated here so everyone builds compatible pieces.

- ONVIF is tried first, always.
- A vendor driver is used only after ONVIF has been seen to accept a write and
  not apply it for that session.
- Falling back must never silently change a value the operator did not ask for.
- The API reports which path produced the result, via `source: "onvif" | "<driver id>"`.
- If the vendor path fails, behaviour degrades to today's honest
  "the camera kept its previous value" — never to a crash or a lie.
- No credentials are ever logged, by any driver.
