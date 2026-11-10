# Spending statistics missed old transactions; broken regexes, tooltips and entry form

- **Date:** 2026-11-10
- **Primary module:** Dashboard
- **Related modules:** Accounts & transactions, Investments, Integrations
- **Status:** Code committed on `claude-dev` (`a7ed523`); tests pass; verified read-only against the Preview database; not deployed
- **TSD:** [Claude Plan 1](../../plans/claude-plan-1.md) Phase 3 (TR-3.1 – TR-3.6) — DEF-05, DEF-09, DEF-10

## Symptoms

- Average monthly spend, yearly averages, cash-flow and category charts used only the latest 500 transactions; with 594 stored, 94 were silently ignored.
- FD maturity dates were always rejected; FD rows showed as bank cards; Angel One TOTP secrets with spaces failed; chart tooltips never appeared; the ledger entry form could not be opened.

## Root cause

- `/api/dashboard` loaded `LIMIT 500` rows and the browser computed statistics from them.
- Regexes written with doubled backslashes inside regex literals (`\\d`, `\\s`, `\\b`) matched literal backslashes.
- The tooltip handler looked for `[data-chart-point]`, which the chart never set; nothing un-hid `#txForm`.

## Resolution

- `api/_queries.js` `spendingRows()`: month × kind × category totals over all transactions in SQL; the browser analytics read these.
- Keyset pagination for transactions (`pageTransactions()`), first 50 on the dashboard, the rest streamed in pages of 200. Cursor keys formatted by Postgres (no time-zone day shift, microsecond precision).
- `/api/ledger`: `cursor`/`limit`, optional `accountId` and `externalRef` (409 on repeat).
- Regexes fixed in `api/positions.js`, `app.js` (2), `api/angel.js`.
- Tooltips on click/tap and Enter/Space, text set via `textContent`; "+ Add entry" in Transactions.

## Verification

- [x] `scripts/tests/transactions.test.mjs`: 620-row paging returns every row once; summary counts all rows; analytics functions from `app.js`.
- [x] Read-only run against the Preview database: summary counts 594/594; paging returns 594 unique rows.
- [ ] Browser check after Development deploy (approval).
