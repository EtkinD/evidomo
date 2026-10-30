#!/usr/bin/env bash
# Cheap smoke check of a freshly built production image (CI job "images"; also runnable
# locally after `docker build`). Usage: smoke-image.sh <api|migrate|demo-seed|web> <image>
# Needs no database, no secrets, and no network beyond loopback. GNU/BSD neutral.
set -euo pipefail

target="${1:?usage: smoke-image.sh <api|migrate|demo-seed|web> <image>}"
image="${2:?usage: smoke-image.sh <api|migrate|demo-seed|web> <image>}"

case "$target" in
  api)
    # Loads the whole route/module graph of the API (pg, pg-boss, sharp, argon2, ...) without
    # starting a server, so a missing production dependency or source file fails here.
    docker run --rm "$image" node -e "import('./src/app.ts').then(() => process.exit(0))"
    ;;
  migrate)
    # drizzle-kit is resolvable and its dependencies load.
    docker run --rm "$image" node /app/node_modules/drizzle-kit/bin.cjs --version
    ;;
  demo-seed)
    # --help loads the seed's module graph (MSW, ffmpeg wrappers, definitions) and exits 0.
    docker run --rm "$image" node src/cli/demo-seed.ts --help > /dev/null
    ;;
  web)
    name="evidomo-smoke-web-$$"
    docker run -d --rm --name "$name" -p 127.0.0.1::3000 "$image" > /dev/null
    trap 'docker stop "$name" > /dev/null 2>&1 || true' EXIT
    port="$(docker port "$name" 3000/tcp | head -n 1 | sed 's/.*://')"
    base="http://127.0.0.1:${port}"
    for _ in $(seq 1 60); do
      curl -fsS -o /dev/null "$base/" 2> /dev/null && break
      sleep 1
    done
    check() { # <path> <expected status>
      local status
      status="$(curl -sS -o /dev/null -w '%{http_code}' "$base$1")"
      if [ "$status" != "$2" ]; then
        echo "FAIL: GET $1 returned $status, expected $2" >&2
        docker logs "$name" >&2 || true
        exit 1
      fi
      echo "ok: GET $1 -> $status"
    }
    check / 200
    check /favicon.svg 200
    # The dev-only design showcase must not be part of a production build.
    check /showcase 404
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac
