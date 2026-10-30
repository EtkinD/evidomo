#!/usr/bin/env bash
# One-command deploy on the server. Run as the `deploy` user from anywhere:
#
#   infra/deploy.sh [<tag-or-branch>] [--dry-run]
#
#   no argument   fast-forward the checked-out branch from origin
#   <tag>         check out that tag (detached); a commit hash works the same way
#   <branch>      check out and fast-forward that branch
#   --dry-run     run every check and print the plan; change nothing
#
# Order: checks -> git -> build -> migrate -> switch -> smoke check. Building and migrating do not
# touch the running containers. If the switch or the smoke check fails, the previous images are
# restored automatically (database migrations are not reverted: keep them backward compatible).
#
# Environment (all optional): ENV_FILE (default infra/.env), SMOKE_BASE_URL (default APP_ORIGIN),
# SMOKE_INSECURE=1 (skip certificate verification in the smoke check), COMPOSE_PROJECT_NAME and
# IMAGE_PREFIX (a second stack for tests).
#
# Linux (GNU) is the target. On macOS (BSD) it runs too, except the concurrent-deploy lock, which
# needs flock(1) and is skipped when flock is missing.
set -euo pipefail

# shellcheck source=infra/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ref=""
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) [ -z "$ref" ] || die "only one ref allowed"; ref="$arg" ;;
  esac
done

# --- checks -------------------------------------------------------------------------------
command -v docker > /dev/null || die "docker is not installed"
docker compose version > /dev/null 2>&1 || die "the docker compose plugin is missing"
docker info > /dev/null 2>&1 || die "cannot reach the docker daemon (is $(id -un) in the docker group?)"
[ "$(id -u)" -ne 0 ] || warn "running as root; the deploy user is the intended account"
check_env_file

if command -v flock > /dev/null; then
  exec 9> "${TMPDIR:-/tmp}/evidomo-deploy.lock"
  flock -n 9 || die "another deploy is running"
fi

# Compose validates required variables (POSTGRES_PASSWORD, LIVE_RUN_ACCESS_CODE) here.
compose config -q || die "compose configuration is invalid (see above)"

site_address="$(env_get SITE_ADDRESS)"
app_origin="$(env_get APP_ORIGIN)"
base_url="${SMOKE_BASE_URL:-$app_origin}"
[ -n "$app_origin" ] || die "APP_ORIGIN is empty in $ENV_FILE"
[ -n "$(env_get DAILY_BUDGET_USD)" ] || die "DAILY_BUDGET_USD is empty in $ENV_FILE (api and worker refuse to start)"
[ -n "$(env_get MODEL_API_KEY)" ] || die "MODEL_API_KEY is empty in $ENV_FILE (api and worker refuse to start in production)"
if [ "${site_address:-:80}" = ":80" ] || [ -z "$site_address" ]; then
  case "$app_origin" in
    http://localhost*) ;;
    *) die "SITE_ADDRESS is ':80' (plain HTTP) but APP_ORIGIN is $app_origin; set SITE_ADDRESS to the domain" ;;
  esac
fi
case "$app_origin" in
  https://* | http://localhost*) ;;
  *) die "APP_ORIGIN must be https:// (or http://localhost for a local run)" ;;
esac
if [ -n "$site_address" ] && [ "$site_address" != ":80" ] && [ "$app_origin" != "https://$site_address" ] && [ -z "${SMOKE_BASE_URL:-}" ]; then
  die "APP_ORIGIN ($app_origin) must be https://<SITE_ADDRESS> (https://$site_address)"
fi
[ "$(env_get NEXT_PUBLIC_SITE_ORIGIN)" = "$app_origin" ] ||
  warn "NEXT_PUBLIC_SITE_ORIGIN differs from APP_ORIGIN; og:image URLs will not be absolute for the site"

cd "$REPO_ROOT"
git rev-parse --git-dir > /dev/null 2>&1 || die "$REPO_ROOT is not a git checkout"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "tracked files have local changes; commit or discard them first"

prev_commit="$(git rev-parse HEAD)"
prev_branch="$(git symbolic-ref --short -q HEAD || true)"
prev_name="$(git describe --tags --always)"
# What to pass to deploy.sh to come back here: the exact tag when there is one, else the commit.
prev_ref="$(git describe --tags --exact-match 2> /dev/null || git rev-parse --short HEAD)"

# --- plan ---------------------------------------------------------------------------------
if [ -n "$ref" ]; then
  target="$ref"
elif [ -n "$prev_branch" ]; then
  target="$prev_branch (fast-forward)"
else
  die "HEAD is detached; pass the tag or branch to deploy"
fi
log "Project $PROJECT, currently at $prev_name ($prev_commit)"
log "Target: $target; smoke check at $base_url"
if [ "$dry_run" = 1 ]; then
  if git fetch --tags --prune origin > /dev/null 2>&1; then log "git fetch: ok"; else warn "git fetch failed"; fi
  log "Dry run: checks passed. Would build, migrate, switch, and smoke check. Nothing changed."
  exit 0
fi

# --- git ----------------------------------------------------------------------------------
restore_checkout() {
  if [ -n "$prev_branch" ]; then git checkout -q "$prev_branch"; else git checkout -q --detach "$prev_commit"; fi
  git reset -q --hard "$prev_commit"
}
git fetch --tags --prune origin
if [ -n "$ref" ]; then
  if git show-ref --verify --quiet "refs/tags/$ref"; then
    git checkout -q --detach "refs/tags/$ref"
  elif git show-ref --verify --quiet "refs/remotes/origin/$ref"; then
    git checkout -q "$ref" 2> /dev/null || git checkout -q -b "$ref" "origin/$ref"
    git merge --ff-only -q "origin/$ref" || { restore_checkout; die "$ref cannot be fast-forwarded"; }
  elif git rev-parse --verify --quiet "$ref^{commit}" > /dev/null; then
    git checkout -q --detach "$ref"
  else
    die "$ref is neither a tag, a remote branch, nor a commit"
  fi
else
  git merge --ff-only -q "origin/$prev_branch" || die "$prev_branch cannot be fast-forwarded to origin/$prev_branch"
fi
new_commit="$(git rev-parse HEAD)"
new_name="$(git describe --tags --always)"
log "Checked out $new_name ($new_commit)"

# --- build (running containers untouched) -------------------------------------------------
# Keep the images that are running as :previous, so a failed switch can go back without a rebuild.
have_previous=0
for name in caddy web api backup; do
  if docker image inspect "$IMAGE_PREFIX-$name:latest" > /dev/null 2>&1; then
    docker tag "$IMAGE_PREFIX-$name:latest" "$IMAGE_PREFIX-$name:previous"
    have_previous=1
  fi
done

fail_before_switch() {
  warn "Failed before the switch: the running containers were not touched."
  restore_checkout || warn "could not restore the previous checkout; run: git checkout $prev_commit"
  exit 1
}

log "Building images"
compose build caddy web api backup migrate || fail_before_switch

# --- migrate (before the switch) ----------------------------------------------------------
log "Starting postgres and applying migrations"
compose up -d --wait postgres || fail_before_switch
compose --profile tools run --rm migrate || fail_before_switch

# --- switch -------------------------------------------------------------------------------
rollback() {
  warn "Switch or smoke check failed."
  if [ "$have_previous" = 1 ]; then
    log "Restoring the previous images and code ($prev_name)"
    for name in caddy web api backup; do
      docker image inspect "$IMAGE_PREFIX-$name:previous" > /dev/null 2>&1 &&
        docker tag "$IMAGE_PREFIX-$name:previous" "$IMAGE_PREFIX-$name:latest"
    done
    compose up -d --no-build --wait --remove-orphans || warn "the previous version did not come back healthy; see: docker compose -p $PROJECT -f infra/compose.yaml logs --tail 100"
    restore_checkout || true
    warn "Rolled back to $prev_name. Migrations already applied were NOT reverted."
  else
    warn "First deploy: nothing to roll back to. Inspect: docker compose -p $PROJECT -f infra/compose.yaml --env-file $ENV_FILE logs --tail 100"
  fi
  exit 1
}

log "Switching services"
compose up -d --no-build --wait --remove-orphans || rollback

log "Smoke check"
smoke_check "$base_url" || rollback

# Dangling layers and week-old build cache would otherwise fill the disk over many deploys.
docker image prune -f > /dev/null 2>&1 || true
docker builder prune -f --filter until=168h > /dev/null 2>&1 || true

log "Deployed $new_name ($new_commit)."
log "Rollback hint: infra/deploy.sh ${prev_ref}"
log "(Migrations are forward-only; a rollback keeps the migrated database.)"
