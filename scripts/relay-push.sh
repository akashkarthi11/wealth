#!/usr/bin/env bash
# Push committed work to GitHub through the karthi-github-relay Vercel project (this laptop cannot reach github.com).
# Only when the owner asks. Usage, from the repo root:
#   scripts/relay-push.sh <branch> "<commit message>" [dry]
# <branch> is claude-dev or development (the relay refuses main). The branch must already hold what you want on GitHub.
# It sends the files that changed since the last relay push (local ref refs/relay/<branch>), as ONE commit, then moves that ref.
# The relay secret is read from RELAY_SECRET_FILE (default ~/.wealth-relay/secret.txt, outside the repo) and is never printed.
set -euo pipefail
BRANCH="${1:?usage: scripts/relay-push.sh <branch> \"<message>\" [dry]}"
MESSAGE="${2:?give a commit message}"
DRY="${3:-}"
SECRET_FILE="${RELAY_SECRET_FILE:-$HOME/.wealth-relay/secret.txt}"
[ -f "$SECRET_FILE" ] || { echo "Relay secret file not found: $SECRET_FILE" >&2; exit 1; }
HEAD_SHA="$(git rev-parse "$BRANCH")"
BASE="$(git rev-parse -q --verify "refs/relay/$BRANCH" || git rev-parse "origin/$BRANCH")"
[ "$BASE" = "$HEAD_SHA" ] && { echo "Nothing new on $BRANCH since the last relay push ($BASE)."; exit 0; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo" "$WORK/sec" "$WORK/job"
git archive "$HEAD_SHA" | tar -x -C "$WORK/repo"          # file contents come from the commit, not the working tree
git diff --name-status "$BASE" "$HEAD_SHA" > "$WORK/job/changes.txt"
printf '%s' "$MESSAGE" > "$WORK/job/message.txt"
cp "$SECRET_FILE" "$WORK/sec/secret.txt"
echo "Sending $(wc -l < "$WORK/job/changes.txt") changed files ($BASE..$HEAD_SHA) to $BRANCH"
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
MSYS_NO_PATHCONV=1 docker run --rm -e BRANCH="$BRANCH" \
  -v "$(w "$WORK/repo"):/repo:ro" -v "$(w "$WORK/sec"):/sec:ro" -v "$(w "$WORK/job"):/work:ro" \
  -v "$(w "$(pwd)/scripts/relay-push.mjs"):/relay-push.mjs:ro" node:20-alpine node /relay-push.mjs $DRY
[ "$DRY" = "dry" ] || git update-ref "refs/relay/$BRANCH" "$HEAD_SHA"
