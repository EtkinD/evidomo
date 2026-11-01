#!/usr/bin/env bash
# Prints the release tag (vX.Y.Z) that points at a commit, or nothing when the commit has none.
# The deploy gate in ci.yml: only a main commit carrying a release tag is deployed. Reads the
# remote's tags (`git ls-remote`), so a tag pushed after the branch, while CI still runs, counts.
# Usage: release-tag.sh <40-hex commit> [<remote url>]
set -euo pipefail

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: expected a 40-hex commit" >&2; exit 2; }
remote="${2:-https://github.com/${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY or pass the remote}.git}"

# An annotated tag (what `npm version` makes) appears twice: as the tag object, and dereferenced
# as `refs/tags/<name>^{}` with the commit it points at. A lightweight tag appears once.
git ls-remote --tags "$remote" 'refs/tags/v*' |
  awk -v sha="$sha" '$1 == sha { name = $2; sub(/^refs\/tags\//, "", name); sub(/\^\{\}$/, "", name); print name }' |
  grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
  sort -u -V |
  tail -n 1 || true
