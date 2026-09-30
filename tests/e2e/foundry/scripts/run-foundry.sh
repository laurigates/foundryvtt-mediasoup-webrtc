#!/usr/bin/env bash
# Start a throwaway Foundry VTT server (felddy/foundryvtt) for the e2e tier.
#
#   FOUNDRY_USERNAME=... FOUNDRY_PASSWORD=... FOUNDRY_ADMIN_KEY=... \
#     tests/e2e/foundry/scripts/run-foundry.sh [start|stop|logs]
#
# start (default):
#   1. prepare-data.ts writes the fixture world + system into the data dir and
#      stages dist/ (compatibility.verified stamped to this build);
#   2. runs the container with the staged module bind-mounted read-only at
#      /data/Data/modules/mediasoup-vtt and FOUNDRY_WORLD set to the fixture;
#   3. waits until Foundry answers on :30000 (the first start downloads the
#      release, ~200 MB, unless the cache dir already holds it).
#
# Environment (all optional except the credentials felddy needs):
#   FOUNDRY_VERSION        build to run (default 14.368); also the image tag
#   FOUNDRY_IMAGE          image (default ghcr.io/felddy/foundryvtt:$FOUNDRY_VERSION)
#   FOUNDRY_USERNAME/PASSWORD  foundryvtt.com account (release download + license)
#   FOUNDRY_LICENSE_KEY    license key (else felddy fetches it from the account)
#   FOUNDRY_ADMIN_KEY      Setup-screen admin password (required by the specs)
#   FOUNDRY_E2E_DATA_DIR   host dir mounted at /data (default test-results/foundry-data)
#   FOUNDRY_E2E_CACHE_DIR  host dir for felddy's CONTAINER_CACHE (default ~/.cache/mediasoup-vtt-foundry)
#   FOUNDRY_E2E_CONTAINER  container name (default mediasoup-vtt-foundry-e2e)
#   FOUNDRY_E2E_PORT       host port (default 30000)
#   FOUNDRY_E2E_WORLD      world id (default mediasoup-e2e)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FOUNDRY_VERSION="${FOUNDRY_VERSION:-14.368}"
IMAGE="${FOUNDRY_IMAGE:-ghcr.io/felddy/foundryvtt:${FOUNDRY_VERSION}}"
DATA_DIR="${FOUNDRY_E2E_DATA_DIR:-${REPO_ROOT}/test-results/foundry-data}"
CACHE_DIR="${FOUNDRY_E2E_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME}/.cache}/mediasoup-vtt-foundry}"
MODULE_DIR="${DATA_DIR}-module"
CONTAINER="${FOUNDRY_E2E_CONTAINER:-mediasoup-vtt-foundry-e2e}"
PORT="${FOUNDRY_E2E_PORT:-30000}"
WORLD="${FOUNDRY_E2E_WORLD:-mediasoup-e2e}"

log() { printf '[run-foundry] %s\n' "$*"; }

stop() {
  if docker container inspect "${CONTAINER}" > /dev/null 2>&1; then
    log "Stopping ${CONTAINER}"
    docker rm --force "${CONTAINER}" > /dev/null
  fi
}

start() {
  command -v docker > /dev/null || {
    log "docker is not installed"
    exit 1
  }
  if [[ -z "${FOUNDRY_ADMIN_KEY:-}" ]]; then
    log "FOUNDRY_ADMIN_KEY is not set: the specs log in to the Setup screen with it."
    exit 1
  fi

  mkdir -p "${DATA_DIR}" "${CACHE_DIR}"
  bun "${REPO_ROOT}/tests/e2e/foundry/scripts/prepare-data.ts" \
    --data "${DATA_DIR}" \
    --module-out "${MODULE_DIR}" \
    --foundry-version "${FOUNDRY_VERSION}" \
    --world "${WORLD}"

  stop
  log "Starting ${IMAGE} as ${CONTAINER} on :${PORT} (world ${WORLD})"
  # --user: the image supports any UID (its /data and resources/ are
  # world-writable), and files it creates in the bind mounts stay ours.
  # Credentials are passed by name, so their values never reach the
  # command line.
  docker run --detach \
    --name "${CONTAINER}" \
    --user "$(id -u):$(id -g)" \
    --publish "127.0.0.1:${PORT}:30000/tcp" \
    --env FOUNDRY_USERNAME \
    --env FOUNDRY_PASSWORD \
    --env FOUNDRY_LICENSE_KEY \
    --env FOUNDRY_ADMIN_KEY \
    --env FOUNDRY_WORLD="${WORLD}" \
    --env FOUNDRY_TELEMETRY=false \
    --env FOUNDRY_IP_DISCOVERY=false \
    --env CONTAINER_CACHE=/cache \
    --env CONTAINER_CACHE_SIZE=2 \
    --volume "${DATA_DIR}:/data" \
    --volume "${MODULE_DIR}:/data/Data/modules/mediasoup-vtt:ro" \
    --volume "${CACHE_DIR}:/cache" \
    "${IMAGE}" > /dev/null

  log "Waiting for Foundry on http://127.0.0.1:${PORT} ..."
  local deadline=$((SECONDS + 900))
  until curl --silent --output /dev/null "http://127.0.0.1:${PORT}/"; do
    if [[ "$(docker container inspect --format '{{.State.Running}}' "${CONTAINER}" 2> /dev/null)" != "true" ]]; then
      log "The container stopped:"
      docker logs --tail 80 "${CONTAINER}" || true
      exit 1
    fi
    if ((SECONDS > deadline)); then
      log "Foundry did not come up within 15 minutes:"
      docker logs --tail 80 "${CONTAINER}" || true
      exit 1
    fi
    sleep 5
  done
  log "Foundry is up."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  logs) docker logs "${CONTAINER}" ;;
  *)
    echo "usage: $0 [start|stop|logs]" >&2
    exit 2
    ;;
esac
