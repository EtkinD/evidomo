#!/usr/bin/env bash
# Runs the load test (infra/load/evidomo.js) with k6 in Docker and keeps the report in data/load/
# (git-ignored). Usage:
#
#   infra/load/run.sh <base-url> [NAME=value ...]
#
# Examples (settings are listed at the top of evidomo.js):
#   infra/load/run.sh http://host.docker.internal:8180 STEPS=10,50,100 HOLD=20s RAMP=10s
#   infra/load/run.sh https://evidomo.example
#
# Read-only GET traffic only: no account, no project, no live run. Run it against production only
# in the window you chose (infra/README.md, "Load test").
#
# macOS (BSD) vs Linux (GNU): nothing here differs. On Docker Desktop (macOS) a server on the same
# machine is reached as host.docker.internal; on Linux use the host's address or --network host.
set -euo pipefail

K6_IMAGE="grafana/k6:2.3.0" # exact version; bump on purpose

[ $# -ge 1 ] || { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }
base_url="$1"
shift
case "$base_url" in
  http://* | https://*) ;;
  *) echo "ERROR: base URL must start with http:// or https://" >&2; exit 2 ;;
esac
command -v docker > /dev/null || { echo "ERROR: docker is not installed" >&2; exit 1; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
report_dir="$repo_root/data/load"
mkdir -p "$report_dir"

env_args=(-e "BASE_URL=$base_url")
for setting in "$@"; do
  case "$setting" in
    [A-Z_]*=*) env_args+=(-e "$setting") ;;
    *) echo "ERROR: expected NAME=value, got: $setting" >&2; exit 2 ;;
  esac
done

# --user: the report files belong to you, not to the image's uid. --ulimit: one socket per VU
# plus the parallel asset downloads; Docker's default is usually enough, this makes it explicit.
exec docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --ulimit nofile=65536:65536 \
  -v "$repo_root/infra/load:/scripts:ro" \
  -v "$report_dir:/out" \
  "${env_args[@]}" \
  "$K6_IMAGE" run /scripts/evidomo.js
