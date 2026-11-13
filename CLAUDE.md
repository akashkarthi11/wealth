# Wealth Ledger — notes for Claude

## Operating rules (read first)
- Read [rules.md](rules.md) before every Wealth database, ledger, portfolio, code, migration or deployment task and follow it.
  It is shared with the owner's other assistant (ChatGPT), so both work to the same rules.
- Key points: a new transaction goes into `wealth_transactions` only; never set a balance to `pending_reconciliation`;
  never switch between Production and Development implicitly; leave `v2` untouched; report branch and commit SHA.

## Pushing to GitHub (relay only, `claude-dev`)
This laptop cannot reach github.com, so **the only way to push code to GitHub is the `karthi-github-relay` Vercel project**.
Never use `git push`, never ask the owner to connect GitHub, and never build another route to GitHub.
- **Only when the owner asks** ("push", "push to dev"). Never push on your own after a commit or a deploy. Before sending, tell the
  owner which files are going out.
- **Default branch is `claude-dev`.** The relay also allows `development` when the owner asks for it. It refuses `main`, never forces,
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

## Reading large files
- Never read `app.js` whole. Search it (Grep) or read only the line range you need (Read with offset/limit).
