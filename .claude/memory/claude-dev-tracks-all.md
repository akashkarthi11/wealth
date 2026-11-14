---
name: claude-dev-tracks-all
description: "claude-dev tracks every file (incl. .env*, .db-backups, public, .vercel); development/main keep .gitignore — strip them on each merge"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 518fdc44-58d6-41ab-861b-3b4e48e4ca5f
  modified: 2026-11-11T13:17:45.706Z
---

The owner wants **all files tracked on the `claude-dev` branch only** (2026-11-11: "push everything no git ignore", then
"i need it in claude branch not all branch"). On claude-dev `.gitignore` is just `node_modules/`; `.env*`, `.db-backups/`,
`.vercel`, `public/` and `.claude/` are committed there. `development` (and `main`) keep the full .gitignore
(`.vercel`, `.env*`, `node_modules/`, `public/`, `.db-backups/`) and must never receive those files. `.claude/` may be tracked everywhere.

**Why:** the repo akashkarthi11/wealth is PUBLIC; the owner accepted the risk for claude-dev only. The secrets were already
exposed in history (commit 9e5692b); rotation was recommended.

**How to apply:** when merging claude-dev → development, use `git merge --no-ff --no-commit claude-dev`, then
`git checkout development -- .gitignore` and `git rm -r -q --cached --ignore-unmatch .env* .db-backups .vercel public`,
check `git ls-files | grep -E '^\.(env|db-backups|vercel)|^public/'` is empty, then commit. Same for development → main.
Related: [[no-v2-merge]].
