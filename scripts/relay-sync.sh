#!/usr/bin/env bash
# Make a GitHub branch hold exactly the same files as a local commit, through the karthi-github-relay (exact comparison by file hash).
# Only when the owner asks. Usage, from the repo root:
#   scripts/relay-sync.sh <github-branch> <local-ref> plan                      # show what differs, send nothing
#   scripts/relay-sync.sh <github-branch> <local-ref> push "<commit message>"   # send the difference as one commit
# Example:  scripts/relay-sync.sh development claude-dev plan
# Files on GitHub that are not in the local commit are REMOVED on GitHub, so always run "plan" first and read it.
# main is only allowed when the relay has GITHUB_RELAY_ALLOW_MAIN=yes. Secrets and build folders are never touched.
set -euo pipefail
BRANCH="${1:?usage: scripts/relay-sync.sh <github-branch> <local-ref> plan|push [message]}"
REF="${2:?give the local branch or commit to copy}"
MODE="${3:-plan}"
MESSAGE="${4:-Sync $BRANCH with $REF (via karthi-github-relay)}"
SECRET_FILE="${RELAY_SECRET_FILE:-$HOME/.wealth-relay/secret.txt}"
[ -f "$SECRET_FILE" ] || { echo "Relay secret file not found: $SECRET_FILE" >&2; exit 1; }
SHA="$(git rev-parse "$REF")"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo" "$WORK/sec" "$WORK/job"
git ls-tree -r "$SHA" > "$WORK/job/local.txt"
[ "$MODE" = "push" ] && git -c core.autocrlf=false -c core.eol=lf archive "$SHA" | tar -x -C "$WORK/repo"
cp "$SECRET_FILE" "$WORK/sec/secret.txt"
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
MSYS_NO_PATHCONV=1 docker run --rm -e BRANCH="$BRANCH" -e MODE="$MODE" -e MESSAGE="$MESSAGE" -e EXPECT="${EXPECT:-}" \
  -v "$(w "$WORK/repo"):/repo:ro" -v "$(w "$WORK/sec"):/sec:ro" -v "$(w "$WORK/job"):/work:ro" \
  -v "$(w "$(pwd)/scripts/relay-sync.mjs"):/relay-sync.mjs:ro" node:20-alpine node /relay-sync.mjs | tee "$WORK/out.txt"
if [ "$MODE" = "push" ]; then
  GH_SHA="$(grep -o 'COMMIT [0-9a-f]\{40\}' "$WORK/out.txt" | tail -1 | cut -d' ' -f2 || true)"
  if [ -n "$GH_SHA" ]; then mkdir -p "$(git rev-parse --git-common-dir)/relay-remote"; printf "%s" "$GH_SHA" > "$(git rev-parse --git-common-dir)/relay-remote/$BRANCH"; fi
fi
