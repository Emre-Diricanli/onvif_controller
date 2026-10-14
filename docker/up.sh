#!/bin/sh
# Build and start the container in the background, wait until its healthcheck
# passes, then print the address to open.
#
# `docker compose up -d` cannot do the last part: detached mode shows only
# Compose's own build/start status, never the app's "Ready — open …" log line.
# Extra arguments pass through to `docker compose up`.
set -eu
cd "$(dirname "$0")/.."

docker compose up -d --build --wait "$@"

# Ask Docker which host address it actually published, rather than guessing
# HOST_PORT — this is the binding compose resolved from .env.
published="$(docker compose port onvif-controller 8080 2>/dev/null || true)"
if [ -n "$published" ]; then
  url="http://$published"
else
  url="$(docker compose logs --no-color onvif-controller 2>/dev/null | sed -n 's/.*Ready — open //p' | tail -n 1)"
fi

echo
echo "  ONVIF Controller is running — open ${url:-http://127.0.0.1:8080}"
echo "  Logs: docker compose logs -f    Stop: docker compose down"
echo
