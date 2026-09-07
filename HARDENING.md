# Safety and correctness hardening — the contract

Five findings from a code review, **all five reproduced before this file was
written**. Two are physical-safety bugs (a camera can keep moving after Stop),
one disables healthy devices, one is a cross-session authorization gap, and one
is a broken promise in the UI.

**This file is frozen.** All four work streams build against it.

---

## 1. PTZ can restart after Stop — HIGH, physical risk

`server/onvif/ptz.js`. `coalescedMove` stores the newest move in
`state.pending` while a request is in flight, and its `finally` block runs that
pending move unconditionally when the in-flight call settles.

`stopMove()` disarms the watchdog and sends Stop, but **never clears
`state.pending`**. Reproduced: move → stop → the queued move executes and the
camera resumes.

Required:

- Stop must **invalidate any pending move** for that profile.
- A move whose request was issued *before* a Stop must not be able to start
  motion when it completes. Sequence the state so a stale callback cannot win.
- Stop stays idempotent — a device that was not moving may fault, and that is
  not an operator-facing error.

The existing dead-man watchdog is a backstop, not the fix. A camera that resumes
and runs to a hard limit can damage itself; correctness here outranks tidiness.

## 2. Disconnect can stop the wrong channel — HIGH

`server/sessions.js`. Teardown disarms the watchdog and then sends Stop to
`session.profiles[0]` only. On a 32-channel recorder, an operator moving channel
7 loses the watchdog and **channel 7 never receives Stop**.

The watchdog is also a single `session.ptzWatchdog` shared across every profile,
so arming a move on one channel disarms the guard for another.

Required:

- Track movement and watchdogs **per channel**, not per session.
- Teardown must send Stop to **every channel with motion in flight**, not the
  first profile.
- Preserve today's fire-and-forget behavior: teardown must not block on a camera
  that has already gone offline.

This is the same wrong-channel class as `CHANNELS.md` — the app assuming one
device is one camera.

## 3. The governor can disable healthy devices — HIGH

`server/device/governor.js`. Every rejection counts toward the breaker,
including `UNSUPPORTED`. **Reproduced:** five `UNSUPPORTED` responses — a healthy
device that simply lacks a feature — open the breaker, and the next healthy
command fails with `DEVICE_BUSY`.

Separately, two timeouts latch the host as `wedged` permanently, and the
exported `resetGovernor()` has **no caller anywhere in the application**, so
there is no way for an operator to recover a host the app has written off.

Required:

- **Classify failures.** Only transport-level failures count toward the breaker:
  timeouts, connection refused/reset, socket errors. A protocol-level answer —
  `UNSUPPORTED`, `BAD_REQUEST`, `UNAUTHORIZED` — means the device answered. It is
  healthy. It must never count.
- **Give the operator a recovery action.** A wedged or open host must be
  clearable from the app, not only by restarting the process.
- Keep the wedge latching. It must not clear itself on a timer — that is what
  deepened the original wedge — but a human must be able to clear it.

## 4. Missing ffmpeg does not fall back to snapshots — MEDIUM

`public/js/player.js`. `/stream/start` rejects with `FFMPEG_MISSING`, and the
player's startup catch enters the error state and rethrows instead of calling
`degrade()`. The README and the server banner both promise a snapshot fallback,
so this is a documented guarantee the code does not deliver.

Required:

- `FFMPEG_MISSING` degrades to snapshot polling rather than showing an error.
- A failed initial stream start should also degrade where snapshots could work,
  rather than dead-ending on an error screen.
- If a case genuinely cannot degrade, say so honestly in the UI — do not claim a
  fallback that will not happen.

## 5. Stream Stop does not check ownership — MEDIUM

`server/routes/media.js`. `/stream/stop` validates that the supplied session
exists, then stops **any** stream id it is given. A caller who knows another
session's stream id can stop that stream.

The WebSocket path already checks ownership. The HTTP path must match: verify
the stream belongs to the session in the URL before stopping it, and return the
same not-found error for a stream that exists but belongs elsewhere — do not
confirm its existence.

## Also in scope

- **Wire governor priorities to real callers.** The priority mechanism exists
  but every production call site uses the default, so **PTZ Stop can queue
  behind ordinary reads** — directly undermining finding 1. Stop must be
  `interactive`; bulk capability walks must be `bulk`.
- **`npm test`.** The smoke suite is undiscoverable without reading the repo.

## Explicitly NOT in scope

- Breaking up the controller view (~1,100 lines). Real debt, but a refactor of
  the file that owns player lifecycle, while fixing lifecycle bugs, risks more
  than it repays. Do it in its own change with the tests already in place.
- Browser-level regression tests. Worth doing; too large to bundle here.

## Definition of done

- A move issued before a Stop can never start motion after it. Test it.
- Teardown stops every channel that was moving, on a multi-channel device.
- `UNSUPPORTED` never opens the breaker; a wedged host is operator-recoverable.
- `FFMPEG_MISSING` degrades instead of erroring.
- One session cannot stop another session's stream.
- PTZ Stop is submitted at interactive priority.
- The existing 308 checks still pass, and the suite is larger.
