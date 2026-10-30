#!/usr/bin/env bash
# Shared helpers for deploy.sh and restore.sh. Sourced, never run. GNU/Linux first; the few
# places where macOS (BSD) differs are marked, so the scripts can also be tried on a laptop.

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034 # used by the scripts that source this file
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$INFRA_DIR/.env}"
PROJECT="${COMPOSE_PROJECT_NAME:-evidomo-prod}"
IMAGE_PREFIX="${IMAGE_PREFIX:-evidomo}"
export IMAGE_PREFIX

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  docker compose -p "$PROJECT" -f "$INFRA_DIR/compose.yaml" --env-file "$ENV_FILE" "$@"
}

# Prints "<octal mode> <owner>" of a file. GNU stat first, BSD stat (macOS) as the fallback.
file_mode_owner() {
  stat -c '%a %U' "$1" 2> /dev/null || stat -f '%Lp %Su' "$1"
}

# Refuses an env file that group or others can read: it holds the database password, the model
# API key, and the live-run access code.
check_env_file() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Create it from infra/.env.example (infra/README.md, step 'Secrets')."
  local mode owner
  read -r mode owner < <(file_mode_owner "$ENV_FILE")
  # Last two octal digits are group and other.
  if [ "$((8#$mode & 8#077))" -ne 0 ]; then
    die "$ENV_FILE has mode $mode; group/other must have no access. Run: chmod 600 $ENV_FILE"
  fi
  [ "$owner" = "$(id -un)" ] || die "$ENV_FILE is owned by $owner, expected $(id -un). Run: chown $(id -un) $ENV_FILE"
}

# Value of KEY in the env file (last assignment wins, surrounding quotes stripped). Used for
# non-secret settings; never print what it returns for secrets.
env_get() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# Host ports published by anything other than caddy. Docker adds its own iptables rules for
# published ports, which ufw does not filter, so any hit here is an exposed service.
unexpected_published_ports() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Label "com.docker.compose.service"}}|{{.Ports}}' |
    awk -F'|' '$1 != "caddy" && $2 ~ /->/ { print $1 ": " $2 }'
}

# GET <base><path> with retries (services were just restarted); fails unless the status matches.
http_check() { # <base> <path> <expected status> [curl args...]
  local base="$1" path="$2" expected="$3" status=""
  shift 3
  for _ in $(seq 1 30); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$base$path" 2> /dev/null || true)"
    [ "$status" = "$expected" ] && { echo "ok: GET $path -> $status"; return 0; }
    sleep 2
  done
  echo "FAIL: GET $path returned ${status:-no response} (expected $expected) at $base" >&2
  return 1
}

# The smoke check through Caddy, the same path visitors use.
smoke_check() { # <base url>
  local base="$1" extra=()
  [ "${SMOKE_INSECURE:-0}" = 1 ] && extra=(-k)
  # ${extra[@]+...}: an empty array is an unbound variable under `set -u` in bash 3.2 (macOS).
  http_check "$base" /api/healthz 200 ${extra[@]+"${extra[@]}"} &&
    http_check "$base" / 200 ${extra[@]+"${extra[@]}"} &&
    http_check "$base" /favicon.svg 200 ${extra[@]+"${extra[@]}"} &&
    http_check "$base" /api/demo/runs 200 ${extra[@]+"${extra[@]}"} || return 1
  local exposed
  exposed="$(unexpected_published_ports)"
  if [ -n "$exposed" ]; then
    echo "FAIL: services other than caddy publish host ports (docker bypasses ufw):" >&2
    echo "$exposed" >&2
    return 1
  fi
  echo "ok: only caddy publishes host ports"
}
