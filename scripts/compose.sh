#!/usr/bin/env bash
# Run docker compose against the deployed stack, e.g.:
#   scripts/compose.sh ps
#   scripts/compose.sh logs -f bot
source "$(dirname "$0")/lib.sh"
compose "$@"
