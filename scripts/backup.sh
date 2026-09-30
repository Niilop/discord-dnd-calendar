#!/usr/bin/env bash
# Dumps the database to $BACKUP_DIR (outside the container) and optionally
# copies it off-server with rclone. Run daily by the systemd timer in
# deploy/systemd, and before every deploy/restore.
#   scripts/backup.sh [label]
source "$(dirname "$0")/lib.sh"

LABEL="${1:-daily}"
BACKUP_DIR="$(env_get BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/dnd-calendar}"
RETENTION_DAYS="$(env_get BACKUP_RETENTION_DAYS)"; RETENTION_DAYS="${RETENTION_DAYS:-14}"
RCLONE_REMOTE="$(env_get BACKUP_RCLONE_REMOTE)"
RCLONE_RETENTION_DAYS="$(env_get BACKUP_RCLONE_RETENTION_DAYS)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
FILE="$BACKUP_DIR/dnd_calendar-$(date -u +%Y%m%dT%H%M%SZ)-$LABEL.dump"

log "dumping database to $FILE"
compose exec -T postgres pg_dump -U dnd -d dnd_calendar --format=custom --compress=9 > "$FILE.partial"
# A dump that pg_restore can't list is not a backup.
compose exec -T postgres pg_restore --list < "$FILE.partial" > /dev/null || die "dump verification failed"
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"
log "dump ok ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'dnd_calendar-*.dump' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name '*.partial' -mmin +60 -delete

if [[ -n "$RCLONE_REMOTE" ]]; then
  command -v rclone > /dev/null || die "BACKUP_RCLONE_REMOTE is set but rclone is not installed"
  log "copying to $RCLONE_REMOTE"
  rclone copy --no-traverse "$FILE" "$RCLONE_REMOTE"
  if [[ -n "$RCLONE_RETENTION_DAYS" ]]; then
    rclone delete --min-age "${RCLONE_RETENTION_DAYS}d" --include 'dnd_calendar-*.dump' "$RCLONE_REMOTE"
  fi
  log "off-server copy ok"
else
  log "WARNING: BACKUP_RCLONE_REMOTE is not set; backups only exist on this server"
fi
