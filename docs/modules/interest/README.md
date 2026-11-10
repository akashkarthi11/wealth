# Interest module

Daily interest earned on Slice Savings and Slice Atom, plus fixed-deposit interest.

## Files

| File | Responsibility |
|---|---|
| [`api/dashboard.js`](../../../api/dashboard.js) | Returns `interest` (latest 500 ledger rows) and `interestStatements` |
| [`app.js`](../../../app.js) | `interestSummaryHtml`, `interestDailySeries`, `activeInterestListHtml`, `interestViewHtml` |
| [`scripts/migrations/2026-11-10-interest-source-registry.sql`](../../../scripts/migrations/2026-11-10-interest-source-registry.sql) | Interest source registry and rate seeds (**manual — not run by `migrate-db.mjs`**) |

## Tables

- `wealth_interest_ledger` — daily accruals with `revision`; the highest revision per `(product_key, account_key, accrual_date)` wins.
- `wealth_interest_statements` — monthly statement totals and `daily_breakdown` JSON.
- `wealth_interest_rates` — rate history (decimal fractions, `effective_from`/`effective_to`).
- `wealth_interest_sources` — links a product to exactly one `wealth_accounts` row or `wealth_positions` row.

## Rules

- Totals prefer the latest monthly statement; otherwise sum known daily values.
- Missing days are shown as "Not recorded", never treated as zero.
- Atom statement days count only when `complete === true`.
- FD interest comes from `metadata.interest_earned_inr` on reconciled FD positions.

## Known issues

- The registry migration hard-codes position UUIDs, so it only applies to one specific database.
