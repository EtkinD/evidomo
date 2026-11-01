#!/usr/bin/env bash
# Asks the production server to deploy one ref over SSH (the deploy job in ci.yml). The server's
# key is restricted to infra/cd/ssh-deploy.sh, which validates the ref again; this side only
# builds the request. Usage: deploy-ssh.sh <40-hex commit | vX.Y.Z>
#
# Environment (GitHub environment secrets, never printed): DEPLOY_SSH_KEY (private key),
# DEPLOY_SSH_HOST_KEY (the server's public host key, "ssh-ed25519 AAAA..."), DEPLOY_SSH_HOST,
# DEPLOY_SSH_USER, and optionally DEPLOY_SSH_PORT (default 22).
set -euo pipefail

ref="${1:-}"
[[ "$ref" =~ ^([0-9a-f]{40}|v[0-9]+\.[0-9]+\.[0-9]+)$ ]] || {
  echo "ERROR: expected a 40-hex commit or a vX.Y.Z tag" >&2
  exit 2
}
for name in DEPLOY_SSH_KEY DEPLOY_SSH_HOST_KEY DEPLOY_SSH_HOST DEPLOY_SSH_USER; do
  [[ -n "${!name:-}" ]] || { echo "ERROR: $name is not set" >&2; exit 2; }
done

umask 077
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$dir/key"
# The host key is pinned under an alias, so the server's address never has to appear in a
# known_hosts line and a server that answers with another key is refused (no trust on first use).
printf 'evidomo-production %s\n' "$DEPLOY_SSH_HOST_KEY" > "$dir/known_hosts"

# ServerAlive keeps the session through quiet build steps; the server prints a line every 15 s.
# Not `exec`: the EXIT trap must still remove the key file.
ssh -T \
  -i "$dir/key" \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o HostKeyAlias=evidomo-production \
  -o UserKnownHostsFile="$dir/known_hosts" \
  -o StrictHostKeyChecking=yes \
  -o LogLevel=ERROR \
  -o ConnectTimeout=20 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=6 \
  -p "${DEPLOY_SSH_PORT:-22}" \
  "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST" \
  "deploy $ref"
