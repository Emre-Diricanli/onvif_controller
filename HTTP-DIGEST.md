# ONVIF over HTTP Digest — the contract

Some recorders answer ONVIF with an **HTTP Digest challenge** on the transport,
not WS-Security. The bundled `onvif` library only ever sends a WS-Security
UsernameToken (`_passwordDigest` = SHA1 over nonce+timestamp+password); it has
NO HTTP-Digest support. So these devices reject every request and the app tells
the operator "credentials rejected" when the password is correct.

**Reproduced on a real device (203.0.113.10, a Lorex N864A6 NVR = Dahua OEM):**
- Dahua CGI accepts <user>:<password> (getDeviceType -> N864A6). Password is VALID.
- ONVIF /onvif/device_service returns HTTP 200 to an anonymous GetSystemDateAndTime.
- With a WS-Security token (digest OR plaintext): HTTP 400 "Sender not Authorized".
- An unauthenticated POST returns `WWW-Authenticate: Digest realm="Login to ..."`.
  The device wants transport-level HTTP Digest (RFC 2617), qop=auth.

**This file is frozen.**

## The fix

1. A reusable HTTP Digest client: given a 401/400 carrying `WWW-Authenticate:
   Digest`, parse realm/nonce/qop/opaque/algorithm, compute the response with a
   per-request incrementing nc + cnonce, and retry the SAME request with an
   `Authorization: Digest` header. MD5 and MD5-sess. This is the same algorithm
   already in tools/probe-isapi.mjs and server/vendor/digest.js — but here it
   must wrap the onvif library's OWN request path, not a hand-built one.

2. Wire it into the connect path so that when WS-Security auth fails on a device
   that offered an HTTP Digest challenge, the app retries the ONVIF call under
   HTTP Digest and, if that works, uses it for the rest of the session. ONVIF's
   `cam._request` is the funnel; the library exposes the raw http path there.

## Rules
- WS-Security stays the DEFAULT and the first attempt. HTTP Digest is a fallback
  triggered only by an observed `WWW-Authenticate: Digest` — never sent blind.
- Never log the password or the Authorization header.
- Credentials never touch disk (SPEC.md §8) — unchanged.
- No new npm dependency. Node's crypto only.
- The existing 336 checks must still pass; this is additive.

## Uncertain / verify on the device
- A first hand-rolled HTTP-Digest retry against this unit returned 401 — the
  nc/qop/cnonce framing or the exact request line likely needs adjustment, OR
  the device wants HTTP Digest AND a WS-Security token together. Confirm against
  203.0.113.10 which combination actually yields a 200 with a Manufacturer.
- Whether the device also has clock skew (it read +1h, DST flag on) — if so,
  the WS-Security path would ALSO need the existing skew tolerance, but HTTP
  Digest does not sign a timestamp so it sidesteps skew entirely.

## Definition of done
- The Lorex at 203.0.113.10 connects through the app with <user>:<password>.
- A mock persona reproduces "answers ONVIF only under HTTP Digest" so this is a
  standing regression test, not a one-off.
- WS-Security-only devices are completely unaffected.
