# 2026-11-11 — Bank balances menu disagreed with the dashboard; account details used static data

- **Status:** deployed and verified in Production (`main` `654b41f`, then `2a2afde`)
- **Plan:** [Claude Plan 3 §14.3](../../plans/claude-plan-3.md)

## Symptoms

- The dashboard's bank balance total and the Bank balances menu showed different figures.
- The account details page listed records from other banks and showed static snapshot tables, not the account's own data.
- The widget layout was hard to read.

## Root cause

- The menu was built from saved snapshot tables (`wealth_snapshots`, `accountRecords`). The dashboard used `wealth_accounts.current_balance`. The two sources drift.
- The details page matched snapshot rows by text, so other banks' rows got through.

## Resolution

| Commit | Change |
|---|---|
| `b84be41` | The menu uses the live account balances (`liveBankAccounts`), with the same CASA rule as the dashboard: `verified` and `stale` (estimated) INR savings/current accounts |
| `dfe0aec` | Redesigned widget (`liveBankCardsHtml`): total, share bar, legend, verified/estimated split, one row per bank with a status chip |
| `68ec9a7` | The details page shows only that bank's records |
| `25983f2` | New `GET /api/account-detail?id=<uuid>` (`api/_routes/account-detail.js`, `accountDetail` in `api/_queries.js`). Owner session; own accounts only (404 otherwise). The page (`accountDetailHtml`, `loadBankDetail`) renders only what the API returns |

`/api/account-detail` returns: account and subtype, the 30 latest balance rows, 6 months of money in (income) and out (expense + investment + liability) with transfers separate, the 25 latest transactions plus the total count, interest with `month_total` and `month_basis`, and upcoming obligations.

## Verification

- `plan3.test.mjs`: "Bank balances menu shows the live account balances and its total equals the dashboard CASA figure", "bank detail page: only that bank's rows …", "account details page comes from the tables …".
- Production (2026-11-11, build `20261111-claude-plan-3h`): `/api/account-detail` returns 401 without a session.

## Notes

- `accountRecords` (snapshot parsing) is no longer used by the active views. It is kept, not deleted.
