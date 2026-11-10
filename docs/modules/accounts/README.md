# Accounts & transactions module

Bank accounts (CASA), balance snapshots and the ledger of income/expense/transfer/investment/liability entries.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/ledger.js`](../../../api/_routes/ledger.js) | `GET/POST/DELETE /api/ledger` |
| [`api/_routes/dashboard.js`](../../../api/_routes/dashboard.js) | Returns accounts and the latest 500 transactions |
| [`api/_routes/snapshot.js`](../../../api/_routes/snapshot.js) | `GET /api/snapshot` — admin-only saved HTML/JSON source snapshots |
| [`app.js`](../../../app.js) | Banks view (`bankCards`, `accountRecords`), Transactions view (`activitiesHtml`, `activityRowsHtml`), spend analytics |

## Tables

- `wealth_accounts` — `account_key`, `bank_name`, `account_name`, `account_type`, `masked_identifier`, `currency`, `current_balance`, `balance_as_of`, `balance_status`.
- `wealth_transactions` — `kind` (`income`/`expense`/`transfer`/`investment`/`liability`), `category`, `description`, `amount`, `account_id`, `occurred_on`.
- `wealth_snapshots` — `source_key`, `source_name`, `snapshot_date`, `payload` (sections/tables/notes, holdings).

## Rules

- CASA counts only accounts with `balance_status='verified'`, INR, type `savings` or `current`.
- Ledger POST validates kind, amount (0 < x ≤ 1e12), date `YYYY-MM-DD`; account is matched by name, name+mask or key.
- Ledger GET is cached in Redis for 20 s with background refresh; writes call `invalidateUserCaches`.
- Bank cards and balance-history charts are built from snapshot tables whose headers contain `account` and `latest balance` / `displayed amount`. `accountKey()` maps labels through the template's `accountAliases`.

## Known issues

- The "New ledger entry" form (`#txForm`) is never shown — there is no UI path to add a transaction.
- FD rows are not filtered from bank cards: the regex is written with `\\b`/`\\s` inside a regex literal ([`app.js:223`](../../../app.js#L223)).
- `renderView` has an unreachable second `bank-detail` branch.
