# Wealth Ledger — notes for Claude

## Operating rules (read first)
- Read [rules.md](rules.md) before every Wealth database, ledger, portfolio, code, migration or deployment task and follow it.
  It is shared with the owner's other assistant (ChatGPT), so both work to the same rules.
- Key points: a new transaction goes into `wealth_transactions` only; never set a balance to `pending_reconciliation`;
  never switch between Production and Development implicitly; leave `v2` untouched; report branch and commit SHA.

## Reading large files
- Never read `app.js` whole. Search it (Grep) or read only the line range you need (Read with offset/limit).
