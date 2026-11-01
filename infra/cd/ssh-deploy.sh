#!/usr/bin/env bash
# Forced command for the continuous-deployment SSH key (infra/README.md, "Continuous
# deployment"). The key's authorized_keys line runs this script and nothing else:
#
#   restrict,command="<repo>/infra/cd/ssh-deploy.sh" ssh-ed25519 AAAA... evidomo-cd
#
# The client asks for `deploy <ref>` (SSH_ORIGINAL_COMMAND), where <ref> is a full commit hash
# on origin/main or a release tag (vX.Y.Z). Anything else is refused, so a leaked key can only
# redeploy code that is already on main or tagged.
#
# The deploy runs detached from the SSH session (setsid), so a dropped connection or a cancelled
# workflow does not kill it halfway; deploy.sh's own lock keeps deploys from overlapping. The
# full output goes to a log on the server only. The client sees the stage lines (`==> ...`) and
# the result, never warnings, errors, paths, or host details: CI logs of a public repository are
# public.
#
# GNU/Linux only (setsid, GNU find).
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
log_dir="${EVIDOMO_DEPLOY_LOG_DIR:-$HOME/evidomo-deploy-logs}"
poll_seconds=15

refuse() { printf 'refused: %s\n' "$1"; exit 2; }

request="${SSH_ORIGINAL_COMMAND:-}"
[[ "$request" =~ ^deploy\ ([0-9a-f]{40}|v[0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  refuse "expected 'deploy <40-hex commit>' or 'deploy vX.Y.Z'"
ref="${BASH_REMATCH[1]}"

cd "$repo_root"
git fetch --quiet --tags --prune origin || { printf 'failed: git fetch\n'; exit 1; }
target="$(git rev-parse --verify --quiet "$ref^{commit}")" || refuse "unknown ref $ref"
current="$(git rev-parse HEAD)"
short="${target:0:12}"

if [[ "$ref" != v* ]]; then
  # A commit must be on main, and an older main commit never replaces a newer one (a re-run of
  # an old workflow). Rolling back is a deliberate manual step: infra/deploy.sh <ref>.
  git merge-base --is-ancestor "$target" origin/main || refuse "$short is not on origin/main"
  if [[ "$target" != "$current" ]] && git merge-base --is-ancestor "$target" "$current"; then
    refuse "$short is older than the deployed commit"
  fi
fi

# deploy.sh restores HEAD when it fails or rolls back, so HEAD is the deployed commit. A release
# tag on the commit main just deployed lands here.
if [[ "$target" == "$current" ]]; then
  printf 'already deployed: %s (%s)\n' "$ref" "$short"
  exit 0
fi

mkdir -p "$log_dir"
log="$log_dir/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$short.log"
status="$log.status"
# shellcheck disable=SC2016 # expanded by the inner shell
setsid bash -c '"$1/infra/deploy.sh" "$2" > "$3" 2>&1 < /dev/null; echo $? > "$4"' \
  _ "$repo_root" "$ref" "$log" "$status" &
printf 'deploying %s (%s)\n' "$ref" "$short"

waited=0
until [[ -s "$status" ]]; do
  sleep "$poll_seconds"
  waited=$((waited + poll_seconds))
  printf 'still deploying (%ss)\n' "$waited"
done

grep '^==> ' "$log" || true
code="$(cat "$status")"
# Thirty days of logs are plenty; deploys are minutes apart at most.
find "$log_dir" -name 'deploy-*.log*' -mtime +30 -delete || true
if [[ "$code" == 0 ]]; then
  printf 'deployed: %s (%s)\n' "$ref" "$short"
else
  printf 'failed: exit %s; full log on the server: %s\n' "$code" "$(basename "$log")"
  exit 1
fi
