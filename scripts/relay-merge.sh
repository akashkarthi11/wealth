#!/usr/bin/env bash
# Merge one branch into another ON GITHUB through the karthi-github-relay (no local merge needed).
# Only when the owner asks. Usage, from the repo root:   scripts/relay-merge.sh <from-branch> <into-branch> ["message"]
# Example:  scripts/relay-merge.sh claude-dev development
# Only claude-dev and development can be merged; never into or from main. A conflict stops with a message and nothing changes.
# To get the merge result onto this laptop afterwards:   scripts/relay-pull.sh <into-branch>
set -euo pipefail
HEAD_BRANCH="${1:?usage: scripts/relay-merge.sh <from-branch> <into-branch> [message]}"
BASE_BRANCH="${2:?usage: scripts/relay-merge.sh <from-branch> <into-branch> [message]}"
MESSAGE="${3:-Merge $HEAD_BRANCH into $BASE_BRANCH (via karthi-github-relay)}"
SECRET_FILE="${RELAY_SECRET_FILE:-$HOME/.wealth-relay/secret.txt}"
[ -f "$SECRET_FILE" ] || { echo "Relay secret file not found: $SECRET_FILE" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sec"; cp "$SECRET_FILE" "$WORK/sec/secret.txt"
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
MSYS_NO_PATHCONV=1 docker run --rm -e HEAD_BRANCH="$HEAD_BRANCH" -e BASE_BRANCH="$BASE_BRANCH" -e MESSAGE="$MESSAGE" \
  -v "$(w "$WORK/sec"):/sec:ro" -v "$(w "$(pwd)/scripts/relay-merge.mjs"):/relay-merge.mjs:ro" node:20-alpine node /relay-merge.mjs
