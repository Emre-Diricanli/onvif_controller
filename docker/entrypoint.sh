#!/bin/sh
set -eu

# ffmpeg is the main reason this image exists; fail loudly rather than letting
# the app degrade to snapshot polling inside a container.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "entrypoint: ERROR: ffmpeg not found on PATH." >&2
  echo "entrypoint: this image exists to ship a known-good ffmpeg; rebuild the image." >&2
  exit 1
fi

# The app's warnIfExposed() prints a scary warning on every start because
# HOST=0.0.0.0. That bind is expected inside a container: the real exposure
# boundary is the published port (compose.yaml publishes 127.0.0.1:8080 only).
echo "entrypoint: HOST=0.0.0.0 inside the container is expected; the exposure boundary is the published port, not the bind address."

# exec so node becomes PID 1's direct child and receives SIGTERM, letting its
# shutdown path stop ffmpeg children instead of leaking them on docker stop.
exec "$@"
