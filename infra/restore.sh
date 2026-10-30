#!/usr/bin/env bash
# Restore the database (and the uploaded files) from a backup made by the backup service.
#
#   infra/restore.sh list
#   infra/restore.sh <latest | daily/evidomo-<timestamp>.dump | weekly/evidomo-<timestamp>.dump> \
#                    [--yes] [--no-storage] [--skip-safety-backup]
#
# The api and worker are stopped, a safety backup of the current state is taken, the database is
# dropped and recreated from the dump, the storage volume is replaced by the matching
# storage-<timestamp>.tar.gz, and the services are started again and smoke checked. Visitors see a
# bad-gateway page from the API in between (a minute or two). Destructive: type the database name
# to confirm, or pass --yes.
set -euo pipefail

# shellcheck source=infra/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

what=""
assume_yes=0
with_storage=1
safety_backup=1
for arg in "$@"; do
  case "$arg" in
    --yes) assume_yes=1 ;;
    --no-storage) with_storage=0 ;;
    --skip-safety-backup) safety_backup=0 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) [ -z "$what" ] || die "only one backup allowed"; what="$arg" ;;
  esac
done
[ -n "$what" ] || die "usage: infra/restore.sh list | latest | <daily|weekly>/evidomo-<timestamp>.dump"

command -v docker > /dev/null || die "docker is not installed"
check_env_file
compose config -q || die "compose configuration is invalid"
compose up -d --wait postgres

in_backup() { compose run --rm --no-deps -T "$@"; }

if [ "$what" = list ]; then
  in_backup backup list
  exit 0
fi

if [ "$what" = latest ]; then
  what="daily/$(in_backup --entrypoint sh backup -c 'ls -1 /backups/daily | grep "^evidomo-.*\.dump$" | sort -r | head -n 1' | tr -d '\r')"
fi
case "$what" in
  daily/evidomo-*.dump | weekly/evidomo-*.dump) ;;
  *) die "backup must look like daily/evidomo-<timestamp>.dump (see: infra/restore.sh list)" ;;
esac
dump="/backups/$what"
storage="/backups/${what%/*}/storage-${what##*/evidomo-}"
storage="${storage%.dump}.tar.gz"

in_backup --entrypoint sh backup -c "test -f '$dump'" || die "$what does not exist (see: infra/restore.sh list)"
have_storage=0
if [ "$with_storage" = 1 ]; then
  if in_backup --entrypoint sh backup -c "test -f '$storage'"; then
    have_storage=1
  else
    die "the matching file archive ${storage#/backups/} is missing; use --no-storage to restore the database only"
  fi
fi

db="$(env_get POSTGRES_DB)"
db="${db:-evidomo}"
log "Restoring $what into database '$db' of project $PROJECT$([ "$have_storage" = 1 ] && echo ', and replacing the storage volume')"
if [ "$assume_yes" != 1 ]; then
  read -r -p "This DELETES the current data. Type the database name ($db) to continue: " answer
  [ "$answer" = "$db" ] || die "aborted"
fi

if [ "$safety_backup" = 1 ]; then
  log "Safety backup of the current state"
  in_backup backup run || die "the safety backup failed; nothing was changed (--skip-safety-backup overrides)"
fi

log "Stopping api and worker"
compose stop api worker

log "Restoring the database"
in_backup backup restore-db "$dump"

if [ "$have_storage" = 1 ]; then
  log "Replacing the storage volume"
  docker run --rm --user 0 \
    -v "${PROJECT}_storage:/data" -v "${PROJECT}_backups:/backups:ro" \
    --entrypoint sh "$IMAGE_PREFIX-backup:latest" \
    -c "find /data -mindepth 1 -delete && tar -C /data -xzf '$storage' && chown -R 1000:1000 /data"
fi

log "Starting api and worker"
compose up -d --wait api worker

base_url="${SMOKE_BASE_URL:-$(env_get APP_ORIGIN)}"
smoke_check "$base_url"
log "Restore complete."
