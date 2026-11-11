# Interest module

Daily interest earned on Slice Savings and Slice Atom, plus fixed-deposit interest.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/dashboard.js`](../../../api/_routes/dashboard.js) | Returns `interest` (latest 500 ledger rows) and `interestStatements` |
| [`api/_interest.js`](../../../api/_interest.js) | Accrual engine (Plan 3 Phase 3): `planAccrual`, `runAccrual` (ledger rows + rolling estimated balance for daily-credited products), `submitRate`, `recordCredit`, `interestOverview` |
| [`api/_routes/interest.js`](../../../api/_routes/interest.js) | `GET /api/interest`, `POST /api/interest/rates`, `POST /api/interest/run`, `POST /api/interest/credits` |
| [`api/_routes/nightly.js`](../../../api/_routes/nightly.js) | Cron `/api/nightly` 20:00 UTC (01:30 IST): accrual, then encrypted backup |
| [`app.js`](../../../app.js) | `interestSummaryHtml`, `interestDailySeries`, `activeInterestListHtml`, `interestViewHtml`, `interestSourcesHtml`, `interestLatestLedger` (sums revisions), `interestMonthTotal` |
| [`scripts/migrations/legacy/2026-11-10-interest-source-registry.sql`](../../../scripts/migrations/legacy/2026-11-10-interest-source-registry.sql) | Interest source registry and rate seeds (**manual — not run by `migrate-db.mjs`**) |

## Tables

- `wealth_interest_ledger` — daily accruals with `revision`. Corrections are signed **delta** revisions, so a day's value is the **sum** of its revisions (changed 2026-11-11, [fix note](2026-11-11-interest-view-day-and-month-totals.md)).
- `wealth_interest_products.credit_frequency` (0009) — `daily` for Slice Savings and Slice Atom: interest compounds and raises the balance as an estimate.
- `wealth_interest_links` (0008) — product ↔ account links used by the engine.
- `wealth_interest_statements` — monthly statement totals and `daily_breakdown` JSON.
- `wealth_interest_rates` — rate history (decimal fractions, `effective_from`/`effective_to`).
- `wealth_interest_sources` — links a product to exactly one `wealth_accounts` row or `wealth_positions` row.

## Rules

- Month total = latest statement total + ledger days after the statement's end date; otherwise sum known daily values.
- Accrual = principal × rate ÷ 365 (366 in leap years), 8 decimals. Principal = latest verified balance, at most 2 days old; confirmed rows are never corrected.
- Missing days are shown as "Not recorded", never treated as zero.
- Atom statement days count only when `complete === true`.
- FD interest comes from `metadata.interest_earned_inr` on reconciled FD positions.

## Known issues

- The registry migration hard-codes position UUIDs, so it only applies to one specific database.
