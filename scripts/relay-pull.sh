#!/usr/bin/env bash
# Bring down changes that were made on GitHub (for example a merge into development) through the karthi-github-relay.
# Only when the owner asks. Usage, from the repo root:   scripts/relay-pull.sh <branch>
# It does NOT touch your working folder or your branches. It puts the pulled files on a NEW local branch relay/<branch>-<sha>
# (made in a separate git worktree) so you can look at it and merge it yourself:   git merge relay/<branch>-<sha>
# The marker file .git/relay-remote/<branch> remembers the last GitHub commit this laptop has seen.
set -euo pipefail
BRANCH="${1:?usage: scripts/relay-pull.sh <branch>}"
SECRET_FILE="${RELAY_SECRET_FILE:-$HOME/.wealth-relay/secret.txt}"
[ -f "$SECRET_FILE" ] || { echo "Relay secret file not found: $SECRET_FILE" >&2; exit 1; }
MARK="$(git rev-parse --git-common-dir)/relay-remote"; mkdir -p "$MARK"
BASE="$(cat "$MARK/$BRANCH" 2>/dev/null || true)"
[ -n "$BASE" ] || { echo "No marker for $BRANCH. Set one first: echo <GitHub commit hash> > $MARK/$BRANCH" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sec" "$WORK/out"
cp "$SECRET_FILE" "$WORK/sec/secret.txt"
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
MSYS_NO_PATHCONV=1 docker run --rm -e BRANCH="$BRANCH" -e BASE="$BASE" \
  -v "$(w "$WORK/sec"):/sec:ro" -v "$(w "$WORK/out"):/out" -v "$(w "$(pwd)/scripts/relay-pull.mjs"):/relay-pull.mjs:ro" node:20-alpine node /relay-pull.mjs | tee "$WORK/log.txt"
grep -q '^UP_TO_DATE$' "$WORK/log.txt" && exit 0
[ -f "$WORK/out/meta.json" ] || { echo "Nothing was pulled." >&2; exit 1; }
SHA="$(grep -o '"sha":"[0-9a-f]\{40\}"' "$WORK/out/meta.json" | cut -d'"' -f4)"
NEW="relay/$BRANCH-${SHA:0:7}"
TREE="$(git rev-parse --show-toplevel)/../wealth-pull-${SHA:0:7}"
git worktree add -q -b "$NEW" "$TREE" "$BRANCH"
[ -d "$WORK/out/files" ] && cp -R "$WORK/out/files/." "$TREE/"
while IFS= read -r f; do [ -n "$f" ] && rm -f "$TREE/$f"; done < "$WORK/out/deleted.txt"
git -C "$TREE" add -A
git -C "$TREE" -c user.name="relay" -c user.email="relay@localhost" commit -q -m "Pull from GitHub $BRANCH ${SHA:0:7}" || echo "(the pulled files are already identical to your branch)"
printf "%s" "$SHA" > "$MARK/$BRANCH"
echo "Pulled onto local branch $NEW (folder $TREE)."
echo "To bring it into $BRANCH:  git merge $NEW   (run it on $BRANCH)"
