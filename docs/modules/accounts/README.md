# Accounts & transactions module

Bank accounts (CASA), balance snapshots and the ledger of income/expense/transfer/investment/liability entries.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/ledger.js`](../../../api/_routes/ledger.js) | `GET/POST/DELETE /api/ledger` |
| [`api/_routes/dashboard.js`](../../../api/_routes/dashboard.js) | Returns accounts and the latest 500 transactions |
| [`api/_routes/snapshot.js`](../../../api/_routes/snapshot.js) | `GET /api/snapshot` — admin-only saved HTML/JSON source snapshots |
| [`api/_routes/account-detail.js`](../../../api/_routes/account-detail.js) | `GET /api/account-detail?id=<uuid>` — one account's details from the tables (owner session, own accounts only); query in `accountDetail` ([`api/_queries.js`](../../../api/_queries.js)) |
| [`api/_routes/balances.js`](../../../api/_routes/balances.js), [`accounts.js`](../../../api/_routes/accounts.js), [`transaction-review.js`](../../../api/_routes/transaction-review.js) | Plan 3 ingest: `POST /api/balances`, `POST/PATCH /api/accounts` (incl. FD terms), duplicate marking and account suggestions |
| [`app.js`](../../../app.js) | Banks view (`liveBankAccounts`, `liveBankCardsHtml`), account details (`accountDetailHtml`, `loadBankDetail`), Transactions view (`activitiesHtml`, `activityRowsHtml`), spend analytics. `accountRecords` (snapshot parsing) is no longer used by the active views |

## Tables

- `wealth_accounts` — `account_key`, `bank_name`, `account_name`, `account_type`, `masked_identifier`, `currency`, `current_balance`, `balance_as_of`, `balance_status`.
- `wealth_transactions` — `kind` (`income`/`expense`/`transfer`/`investment`/`liability`), `category`, `description`, `amount`, `account_id`, `occurred_on`.
- `wealth_snapshots` — `source_key`, `source_name`, `snapshot_date`, `payload` (sections/tables/notes, holdings).

## Rules

- CASA counts INR `savings`/`current` accounts with `balance_status` `verified` or `stale`. Since 2026-11-11 `stale` in v1 means **estimated** (last verified balance + daily-credited interest); v2 stores it as a `wealth_account_balances` row with status `estimated`. See [Plan 3 §14.1](../../plans/claude-plan-3.md).
- The Bank balances menu and the dashboard use the same live balances; the account details page shows only data from `/api/account-detail` ([fix note](2026-11-11-bank-balances-live-and-account-details.md)).
- Transactions marked `duplicate_of` are excluded from spending statistics.
- Ledger POST validates kind, amount (0 < x ≤ 1e12), date `YYYY-MM-DD`; account is matched by name, name+mask or key.
- Ledger GET is cached in Redis for 20 s with background refresh; writes call `invalidateUserCaches`.
- ~~Bank cards and balance-history charts are built from snapshot tables~~ — replaced 2026-11-11 by live balances and `/api/account-detail`.

## Known issues

- The "New ledger entry" form (`#txForm`) is never shown — there is no UI path to add a transaction.
- FD rows are not filtered from bank cards: the regex is written with `\\b`/`\\s` inside a regex literal ([`app.js:223`](../../../app.js#L223)).
- `renderView` has an unreachable second `bank-detail` branch.
