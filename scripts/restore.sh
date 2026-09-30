#!/usr/bin/env bash
# Restores a dump made by backup.sh. Stops the bot, takes a safety backup of
# the current database, restores in a single transaction, starts the bot.
#   scripts/restore.sh /var/backups/dnd-calendar/dnd_calendar-...dump [--yes]
source "$(dirname "$0")/lib.sh"

DUMP="${1:?usage: restore.sh <dump-file> [--yes]}"
[[ -f "$DUMP" ]] || die "no such file: $DUMP"

if [[ "${2:-}" != "--yes" ]]; then
  echo "This replaces ALL data in the dnd_calendar database with $DUMP."
  read -r -p "Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || die "aborted"
fi

log "verifying dump"
compose exec -T postgres pg_restore --list < "$DUMP" > /dev/null || die "not a valid pg_dump custom-format file"

log "safety backup of current data"
"$APP_DIR/scripts/backup.sh" pre-restore

log "stopping bot"
compose stop bot

log "restoring"
status=0
compose exec -T postgres pg_restore -U dnd -d dnd_calendar --clean --if-exists --no-owner --single-transaction < "$DUMP" || status=$?

# An older dump may predate newer migrations.
log "applying migrations"
compose run --rm --no-deps bot node dist/scripts/migrate.js

log "starting bot"
compose up -d --no-deps --wait --wait-timeout 150 bot

(( status == 0 )) || die "restore failed; the database was left unchanged (single transaction)"
log "restore complete"
