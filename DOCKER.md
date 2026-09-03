# Containerizing the controller — the contract

Docker is a good fit here for one reason above all: **ffmpeg**. Today the app
degrades to snapshot polling when ffmpeg is missing from `PATH`, and getting a
working ffmpeg onto an operator's machine is the single most common setup
failure. An image pins a known-good ffmpeg alongside a known-good Node 20.

**This file is frozen.** All three work streams build against it.

---

## The security problem containerization creates

The app **binds `127.0.0.1` by default and has no authentication whatsoever**
(SPEC.md §8). Anything that can reach the port can pan cameras, rewrite network
settings, and reboot recorders.

Inside a container, `127.0.0.1` is the *container's* loopback — nothing outside
can reach it, so the app would appear broken. The image therefore has to bind
`0.0.0.0` internally. That is safe **only** because the publish address controls
real exposure:

```
ports: ["127.0.0.1:8080:8080"]     # correct — reachable only from this host
ports: ["8080:8080"]               # WRONG — exposes camera control to the LAN
```

Rules, non-negotiable:

- **Default to publishing on `127.0.0.1` only.** Every compose file, every
  documented `docker run`, every example. A reader who copies the first command
  they see must land in the safe configuration.
- **`HOST=0.0.0.0` inside the container is expected and correct.** The existing
  `warnIfExposed()` will fire on every start; that is noise in this context, so
  the container entrypoint must make clear that the real boundary is the
  published port, not the bind address. Do not delete or weaken the warning for
  the non-container case.
- **Never document `--network host`** as the default. It bypasses the port
  publishing that provides the boundary.
- **Never bake credentials into the image or compose file.** Camera passwords
  are typed per session and never touch disk (SPEC.md §8). A fan-out secret may
  be mounted as a file but must never appear in a `Dockerfile`, an `ENV`, or a
  committed `.env`.

## Constraints inherited from SPEC.md §1

These do not relax because we are adding a Dockerfile:

- Node 20, exactly three npm dependencies, **no build step**, no framework,
  no CDN. The image installs dependencies; it does not compile anything.
- ffmpeg stays an **external binary**, not an npm package.
- The frontend is served as static files, exactly as it is today.

## Image requirements

- **Node 20** (match `engines.node >= 20`) on a small base.
- **ffmpeg present and on `PATH`.** This is the main reason the image exists;
  verify it at build time rather than discovering it at runtime.
- **`npm ci --omit=dev`** for reproducibility. There are no dev dependencies
  today, but the flag keeps that true if any are added.
- **Run as a non-root user.** The app needs no privileged capability: it makes
  outbound TCP to cameras and listens on one unprivileged port.
- **Multi-stage** so that build-time npm state does not ship in the final layer.
- **`.dockerignore`** must exclude `node_modules`, `.git`, logs, and any local
  config that could carry secrets — both for image size and to avoid baking a
  developer's `fanout.json` into a layer.
- A **healthcheck** hitting the existing `GET /api/health`, which already
  reports `{ ok, ffmpeg }`.
- **Signals must work.** The server has a real shutdown path (`shutdown()` on
  SIGINT/SIGTERM) that stops ffmpeg children and tears down sessions. If PID 1
  swallows signals, every `docker stop` leaks ffmpeg processes and takes the
  full 10s kill timeout. Ensure the Node process actually receives SIGTERM.

## Networking reality — the part that will actually bite

Cameras live on LANs, often on other VLANs. A container on a bridge network
reaches them by routing through the host, which usually works for **outbound**
connections. Two things do not:

- **WS-Discovery** (`discoverDevices()`) is UDP multicast to `239.255.255.250`.
  It will **not** cross a bridge network. Device discovery will find nothing in
  a default container. Say so plainly in the docs rather than letting an
  operator conclude the app is broken — connecting by IP still works, and that
  is the normal path anyway.
- **RTSP over UDP** can fail behind NAT. The pipeline already prefers TCP, so
  this is expected to be fine, but it is worth stating.

Do not "fix" either by defaulting to `--network host`. Mention host networking
only as an explicitly-opt-in note for operators who need discovery, with the
exposure consequence stated.

## Deliverables

| File | Owner | Purpose |
| --- | --- | --- |
| `Dockerfile`, `.dockerignore` | codex | multi-stage image, ffmpeg, non-root, healthcheck |
| `compose.yaml`, `docker/entrypoint.sh` | kimi | loopback-published compose, env surface, entrypoint |
| `DOCKER.md`, `README.md` section, smoke checks | claude | the contract, operator docs, tests |

## Definition of done

- `docker compose up` serves the app at `http://127.0.0.1:8080` and nowhere else.
- `/api/health` reports `ffmpeg: true` inside the container.
- `docker stop` exits promptly with no orphaned ffmpeg processes.
- The image runs as a non-root user.
- No credential, secret, or personal config file is present in any image layer.
- Documentation states the discovery limitation and the publish-address rule.
- The existing test suite still passes unchanged (253 checks); Docker is
  additive and must not alter application behavior.
