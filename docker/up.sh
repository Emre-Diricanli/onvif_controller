#!/bin/sh
# Build and start the container in the background, wait until its healthcheck
# passes, then print the address to open.
#
# `docker compose up -d` cannot do the last part: detached mode shows only
# Compose's own build/start status, never the app's "Ready — open …" log line.
# Extra arguments pass through to `docker compose up`.
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo >&2
  echo "  $1" >&2
  shift
  for line in "$@"; do echo "  $line" >&2; done
  echo >&2
  exit 1
}

# The two first-run failures on a fresh machine, caught before Docker turns
# them into an unreadable error.
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running." "Start Docker Desktop, wait until it says it is running, then run this again."
fi

# Same precedence compose uses: the shell environment, then .env, then 8080.
port="${HOST_PORT:-}"
if [ -z "$port" ] && [ -f .env ]; then
  port="$(sed -n 's/^[[:space:]]*HOST_PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d '"'"'"' ')"
fi
port="${port:-8080}"

# A port held by THIS app's own container is fine (this is a rebuild); held by
# anything else, the publish would fail with "port is already allocated".
ours="$(docker compose port onvif-controller 8080 2>/dev/null || true)"
if [ "$ours" != "127.0.0.1:$port" ] && command -v lsof >/dev/null 2>&1 \
  && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  holder="$(lsof +c 0 -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}')"
  # Docker Desktop's proxy owns every published port; name the real culprit.
  case "$holder" in com.docker*|docker*|vpnkit*) holder="another Docker container (see: docker ps)" ;; esac
  fail "Port $port is already in use${holder:+ by $holder}." \
    "Pick another one, e.g.:   HOST_PORT=8081 npm run up" \
    "or make it permanent:     echo HOST_PORT=8081 > .env"
fi

docker compose up -d --build --wait "$@"

# Ask Docker which host address it actually published, rather than trusting
# the guess above — this is the binding compose resolved.
published="$(docker compose port onvif-controller 8080 2>/dev/null || true)"
url="http://${published:-127.0.0.1:$port}"

echo
echo "  ONVIF Controller is running — open $url"
echo "  Logs: docker compose logs -f    Stop: docker compose down"
echo
