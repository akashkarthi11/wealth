# Wealth Ledger — notes for Claude

## Operating rules (read first)
- Read [rules.md](rules.md) before every Wealth database, ledger, portfolio, code, migration or deployment task and follow it.
  It is shared with the owner's other assistant (ChatGPT), so both work to the same rules.
- Key points: a new transaction goes into `wealth_transactions` only; never set a balance to `pending_reconciliation`;
  never switch between Production and Development implicitly; leave `v2` untouched; report branch and commit SHA.

## GitHub through the relay: push, pull, merge (`claude-dev`)
This laptop cannot reach github.com, so **the only way to push, pull or merge on GitHub is the `karthi-github-relay` Vercel project**.
Never use `git push`, `git pull` or `git fetch` against GitHub, never ask the owner to connect GitHub, and never build another route to it.
- **Pull** (only when asked, and before a push if others may have pushed): `scripts/relay-pull.sh <branch>`. Read only. It brings the files
  that changed on GitHub since the last known GitHub commit onto a NEW local branch `relay/<branch>-<sha>` in a separate worktree
  (`../wealth-pull-<sha>`), without touching the working folder or any branch. Tell the owner what it found (the script prints the commit
  titles) and merge it only when asked: `git merge relay/<branch>-<sha>` on the target branch. The last GitHub commit seen is a marker file
  `.git/relay-remote/<branch>`.
- **Merge on GitHub** (only when asked): `scripts/relay-merge.sh <from> <into>`, for example `claude-dev development`. Only `claude-dev` and
  `development`; `main` only when the owner asks for it in that message (see **`main` deploys Production** below). A conflict stops with a
  message and changes nothing (do not force); resolve it locally, push again.
  Afterwards run `scripts/relay-pull.sh <into>` to bring the merge result down.
- **Push stops if GitHub has moved** since the last known commit (another push or merge): run `scripts/relay-pull.sh <branch>` first, merge what
  it brings, then push again. Never override that stop.
- **Push** (below).
- **Only when the owner asks** ("push", "push to dev"). Never push on your own after a commit or a deploy. Before sending, tell the
  owner which files are going out.
- **`main` deploys Production.** `vercel.json` builds `main` and `development`, so updating `main` on GitHub starts a Production build that
  applies every pending migration to the Production database. Never send `main` unless the owner asks for `main` in that message; "push" alone
  always means `claude-dev`. The relay needs both `main` in `GITHUB_RELAY_BRANCHES` and `GITHUB_RELAY_ALLOW_MAIN=yes` in the
  `karthi-github-relay` project, and a redeploy of that project, before it will accept `main` at all. Both switches are off, which is the safer
  default: GitHub `main` is updated by the owner, and Production is deployed with the Vercel CLI when the owner says "deploy prod".
- **Work on `claude-dev`, and keep all three local branches on the same commit.** After committing, fast-forward local `development` and
  `main` onto `claude-dev` (`git fetch . claude-dev:development`), so the three never drift. Only GitHub `main` is allowed to lag.
- **Default branch is `claude-dev`.** The relay also allows `development` when the owner asks for it. It never forces,
  and refuses `.env*`, `.vercel`, `public/`, `node_modules` and key files.
- **How:** commit first (the relay sends committed work only), then from the repo root run
  `scripts/relay-push.sh claude-dev "<commit message>"` (add `dry` as a third word to list the files without sending).
  It needs Docker. It sends the files changed since the last relay push as one commit and then moves the local marker
  `refs/relay/claude-dev` (a local ref, not pushed). For `development`, merge into the local `development` branch first (in a separate
  `git worktree`, so the working folder is not switched), then run the script with `development`.
- **Secret:** read from `~/.wealth-relay/secret.txt` (outside the repo). Never print it, commit it or paste it in chat. The GitHub token
  lives only in the Vercel project `karthi-github-relay` (settings `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_RELAY_SECRET`,
  `GITHUB_RELAY_BRANCHES`). If a push fails with "not accessible by personal access token", the token is missing, expired or lacks
  Contents read-and-write on `akashkarthi11/wealth`: ask the owner for a new one in that Vercel project; do not ask for the token itself.
- **Report** the commit link the script prints. The result on GitHub is one combined commit per push, not the individual local commits.

## Tests run here, not on Vercel
The Vercel build is `validate-homepage && migrate-db` only. The test suite was taken out of it because 35 of the 66
test files start a real Postgres (PGlite) and replay all the migrations, which pushed deploys past ten minutes.
**So the build no longer catches a failing test: nothing stops a broken commit from reaching Production.**
Run `node scripts/run-tests.mjs` in Docker and read the totals **before every push and every deploy**, and say the
numbers in the report. Two failures are expected on this laptop (Redis and the Preview-migration checks need network).

## Reading large files
- Never read `app.js` whole. Search it (Grep) or read only the line range you need (Read with offset/limit).
