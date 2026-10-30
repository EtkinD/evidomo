#!/bin/sh
# Backups inside the backup container (busybox/alpine; POSIX sh).
#
#   backup.sh schedule        Loop forever: one backup a day at BACKUP_AT (UTC, HHMM), and one
#                             immediately when the newest is older than 24 hours.
#   backup.sh run             One backup now (daily/, plus weekly/ on Sundays).
#   backup.sh list            Print the available backups, newest first.
#   backup.sh restore-db FILE Restore a dump into a freshly created database (the caller stops
#                             the api and worker first; infra/restore.sh does that).
#
# Layout under /backups:
#   daily/evidomo-<UTC timestamp>.dump      pg_dump --format=custom (compressed), newest 7 kept
#   daily/storage-<UTC timestamp>.tar.gz    the uploaded files and artifacts (/data), newest 7 kept
#   weekly/...                              a copy of the Sunday backup, newest 4 kept
#
# The database rows reference files in the storage volume, so both are saved together; a dump
# without its files would restore into broken links.
#
# Connection settings come from the standard PG* environment variables.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATA_DIR="${DATA_DIR:-/data}"
BACKUP_AT="${BACKUP_AT:-0315}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Keeps the newest $3 files named <prefix>-*<suffix> in directory $1. Timestamps in the names make
# the glob's alphabetical order chronological, so the oldest come first.
prune() { # <dir> <prefix> <keep> <suffix>
  total=0
  for f in "$1"/"$2"-*"$4"; do
    [ -e "$f" ] && total=$((total + 1))
  done
  excess=$((total - $3))
  for f in "$1"/"$2"-*"$4"; do
    [ "$excess" -gt 0 ] || break
    rm -f -- "$f"
    log "pruned $f"
    excess=$((excess - 1))
  done
}

# Every step ends in `|| return 1` because callers use `run_backup || ...`, which switches
# `set -e` off inside the function.
run_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  daily="$BACKUP_DIR/daily"
  mkdir -p "$daily" "$BACKUP_DIR/weekly" || return 1
  db="$daily/evidomo-$stamp.dump"
  files="$daily/storage-$stamp.tar.gz"

  # Written under a .partial name and renamed, so a failure never leaves a truncated file that
  # looks like a backup.
  if ! write_backup; then
    rm -f -- "$db.partial" "$files.partial"
    return 1
  fi
  log "wrote $db ($(du -h "$db" | cut -f1)) and $files ($(du -h "$files" | cut -f1))"

  # Sunday (ISO weekday 7): keep a copy for four weeks.
  if [ "$(date -u +%u)" = 7 ]; then
    cp -- "$db" "$files" "$BACKUP_DIR/weekly/" || return 1
    log "copied to weekly/"
  fi

  prune "$daily" evidomo "$KEEP_DAILY" .dump
  prune "$daily" storage "$KEEP_DAILY" .tar.gz
  prune "$BACKUP_DIR/weekly" evidomo "$KEEP_WEEKLY" .dump
  prune "$BACKUP_DIR/weekly" storage "$KEEP_WEEKLY" .tar.gz
}

write_backup() {
  pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$db.partial" || return 1
  # Refuse a dump pg_restore cannot read.
  pg_restore --list "$db.partial" > /dev/null || return 1
  tar -C "$DATA_DIR" -czf "$files.partial" . || return 1
  mv -- "$files.partial" "$files" || return 1
  mv -- "$db.partial" "$db" || return 1
}

fresh_backup_exists() { # newer than 24 hours
  find "$BACKUP_DIR/daily" -name 'evidomo-*.dump' -mmin -1440 2> /dev/null | grep -q .
}

schedule() {
  log "scheduler started; daily at $BACKUP_AT UTC, keeping $KEEP_DAILY daily and $KEEP_WEEKLY weekly"
  if ! fresh_backup_exists; then
    log "no backup in the last 24 hours; taking one now"
    run_backup || log "FAILED (will retry in 5 minutes)"
  fi
  while :; do
    today="$(date -u +%Y%m%d)"
    now="$(date -u +%H%M)"
    # One per UTC day, after BACKUP_AT; a failed attempt is retried on the next tick.
    if [ "$now" -ge "$BACKUP_AT" ] && ! ls "$BACKUP_DIR/daily/evidomo-${today}T"*.dump > /dev/null 2>&1; then
      run_backup || log "FAILED (will retry in 5 minutes)"
    fi
    sleep 300
  done
}

list() {
  for dir in daily weekly; do
    echo "$dir:"
    find "$BACKUP_DIR/$dir" -type f 2> /dev/null | sed 's|.*/|  |' | sort -r
  done
}

restore_db() {
  file="${1:?usage: backup.sh restore-db FILE}"
  [ -f "$file" ] || { log "no such file: $file"; exit 1; }
  pg_restore --list "$file" > /dev/null
  target="$PGDATABASE"
  # Connect to the maintenance database to replace the target.
  PGDATABASE=postgres dropdb --if-exists --force "$target"
  PGDATABASE=postgres createdb "$target"
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$file"
  log "restored $file into $target"
}

case "${1:-schedule}" in
  schedule) schedule ;;
  run) run_backup ;;
  list) list ;;
  restore-db) shift; restore_db "$@" ;;
  *) echo "usage: backup.sh schedule|run|list|restore-db FILE" >&2; exit 2 ;;
esac
