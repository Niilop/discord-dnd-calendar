#!/usr/bin/env bash
# Deploys a bot image on this server. Invoked by GitHub Actions over SSH:
#   scripts/deploy.sh ghcr.io/<owner>/<repo>@sha256:...
#
# Steps: pull → ensure postgres is up → pre-deploy backup → migrate →
# register commands → replace bot container → wait for healthy.
# If the new container does not become healthy, the previous image is
# restored and the script fails. Never removes volumes or data.
source "$(dirname "$0")/lib.sh"

IMAGE="${1:?usage: deploy.sh <image>}"
PREVIOUS="$(grep -E '^BOT_IMAGE=' .deploy/image.env | cut -d= -f2- || true)"

next() { docker compose --env-file .env --env-file .deploy/image.env.next "$@"; }

log "deploying $IMAGE (previous: ${PREVIOUS:-none})"
docker pull --quiet "$IMAGE"
echo "BOT_IMAGE=$IMAGE" > .deploy/image.env.next

log "starting postgres"
next up -d --wait --wait-timeout 120 postgres

log "pre-deploy backup"
"$APP_DIR/scripts/backup.sh" pre-deploy

log "running migrations"
next run --rm --no-deps bot node dist/scripts/migrate.js

log "registering slash commands"
next run --rm --no-deps bot node dist/scripts/registerCommands.js

log "replacing bot container"
if next up -d --no-deps --wait --wait-timeout 150 bot; then
  mv .deploy/image.env.next .deploy/image.env
  log "health: $(compose exec -T bot node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>r.text()).then(console.log)")"
  docker image prune -f >/dev/null
  log "deploy succeeded"
else
  log "new bot container is not healthy; recent logs:"
  next logs --tail 50 bot || true
  if [[ -n "$PREVIOUS" ]]; then
    log "rolling back to $PREVIOUS"
    compose up -d --no-deps --wait --wait-timeout 150 bot || log "rollback did not become healthy either"
  fi
  rm -f .deploy/image.env.next
  die "deploy failed"
fi
