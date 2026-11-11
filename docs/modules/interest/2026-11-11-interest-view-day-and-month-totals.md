# 2026-11-11 — Interest view: wrong day total after a correction; month total ignored new days

- **Status:** deployed to Production (`main` `0a91031`, then `2a2afde`)
- **Plan:** [Claude Plan 3 §14.2](../../plans/claude-plan-3.md)

## Symptoms

- 9 Nov showed **−₹7.21** for Slice Savings. The real day total was the original accrual plus the correction.
- The chart and the "statement total" stayed on the last monthly statement. Days accrued after the statement's end date were not added.

## Root cause

- `app.js` took only the highest `revision` row per day. Corrections are signed **delta** revisions (Plan 3 Phase 3), so the newest row is the change, not the total.
- The month total used `wealth_interest_statements.total` only.

## Resolution

- `interestLatestLedger` sums every revision for a `(product, account, day)`. Commit `f42727e`.
- `interestMonthTotal` = statement total + ledger days after the statement's `period_end`. The same rule is used server-side in `accountDetail` (`month_total`, `month_basis`). Commit `79ff474`.

## Verification

- `plan3.test.mjs`: "interest view: a day with correction revisions shows the sum of its rows (9 Nov 2026 Slice Savings = 7.21)" and "interest month total = statement through its end date + ledger days after it".

## Related

- [Interest module](README.md). Corrections are never written over confirmed rows.
