# Shared helpers for the server scripts. Sourced, not executed.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$0")" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[[ -f .env ]] || die "$APP_DIR/.env is missing (copy .env.example and fill it in)"
mkdir -p .deploy
touch .deploy/image.env

# docker compose with the secrets file plus the currently deployed image tag.
compose() { docker compose --env-file .env --env-file .deploy/image.env "$@"; }

# Reads KEY from .env without sourcing it (values may contain shell metacharacters).
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n1 || true)"
  printf '%s' "${line#*=}"
}
