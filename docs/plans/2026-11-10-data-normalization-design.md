# Data Normalization Design — No Duplicate Data, Keys Doing the Work

- **Date:** 2026-11-10
- **Status:** Proposed. Stage 1 and 2 SQL drafted and syntax-checked against Neon (read-only); nothing applied
- **Parent plan:** [Database optimization plan](2026-11-10-database-optimization-plan.md) (replaces its Phases 2, 3 and 5)
- **Audit:** [`scripts/db/audit-duplicates.sql`](../../scripts/db/audit-duplicates.sql) — every query returns 0 rows when clean

## Rules

1. **Every fact is stored once.** Anything derivable (latest price, totals, average price) is computed, not copied.
2. **Every relationship is a foreign key.** No text keys pointing at other tables, no "polymorphic" id columns without a constraint.
3. **Ownership is enforced, not trusted.** Child tables that carry `user_id` reference the parent on `(user_id, id)`, so a row can never belong to a different user than its parent.
4. **Natural duplicates are blocked by unique keys.** Imports become idempotent through a unique external reference, not by `NOT EXISTS` checks in scripts.
5. **One index per access path.** No two indexes on the same columns.

## Measured duplication (Preview database, 2026-11-10)

| # | Duplication | Rows | Stage |
|---|---|---|---|
| 1 | Investment assets repeat the position's name and currency | 26/26 | 3 |
| 2 | Position `metadata` repeats columns / snapshot data (`original_holding`, `average_price`, `last_traded_price`, `quantity`, …) | 22/33 | 2 |
| 3 | `wealth_transactions.account` text repeats the linked account's name (with inconsistent spelling) | 548 linked rows | 3 |
| 4 | Fixed deposit stored as a bank account *and* as FD positions | 1 | 2 (decision) |
| 5 | Same obligation stored as planned bill + mandate + recurring obligation | 3 tables | 3 |
| 6 | Active mandates linked to **cancelled** obligations (LIC, Slice auto-deposit) | 2 | 2 |
| 7 | Two open-ended interest rates for Slice savings | 1 product | 2 |
| 8 | Latest price stored in `wealth_market_prices` and again in `wealth_price_history` | 22/26 | 3 |
| 9 | Stock Advisor report also stored as a snapshot | 1 | 2 |
| 10 | Identical transaction pairs (may be genuine) | 5 pairs | 2 (decision) |
| 11 | Indexes duplicating a constraint index | 4 | 1 |
| 12 | Single-column FKs that a composite owner FK would make redundant | 13 | 1 |
| 13 | Interest ledger / statements / rates identify products by repeated text (`provider`, `product_key`, `account_key`) | all rows | 3 |
| 14 | Credit-card balance stored as a LIABILITY position, a `liability` transaction and `metadata.cycle_liability` (₹30,634.21 vs ₹30,536.95) | 3 copies | 3 |

## Stage 1 — Keys only, no row changes
[`scripts/migrations/drafts/2026-11-10-normalization-stage1-keys.sql`](../../scripts/migrations/drafts/2026-11-10-normalization-stage1-keys.sql)

- `UNIQUE (user_id, id)` on positions, investment assets, recurring obligations, subscriptions, snapshots.
- 13 composite owner FKs (`NOT VALID` → `VALIDATE`), using `ON DELETE SET NULL (column)` so deleting a parent never nulls `user_id`.
- Unique keys: one active position per holding; one advisor report per run; optional `wealth_transactions.external_ref` unique per user.
- Drop 4 duplicate indexes and the 13 single-column FKs now implied by the composite ones.
- Audit shows 0 owner mismatches and 0 duplicate holdings/reports, so validation is expected to pass.
- **Ship together with** removing the two `CREATE UNIQUE INDEX` lines in `scripts/migrate-db.mjs` that would re-create dropped indexes on every deploy.

## Stage 2 — Remove duplicated data (approval per environment)
[`scripts/migrations/drafts/2026-11-10-normalization-stage2-data.sql`](../../scripts/migrations/drafts/2026-11-10-normalization-stage2-data.sql)

- Re-point the LIC and Slice auto-deposit obligations to their active mandates (their planned occurrences become valid again).
- Close the older Slice savings rate; add "one open rate per product" unique index.
- Strip duplicated keys from position metadata (also stops the deploy-time price seed from overwriting live prices).
- Delete the advisor snapshot copy (only when the report table has it).
- **Decision needed:** the `fixed-deposits` account row; the 5 identical transaction pairs.

## Stage 3 — Consolidate tables (needs app changes, separate approval)

> Superseded for accounts, positions and prices by the [Account hierarchy model](2026-11-10-account-hierarchy-model.md). The obligations and interest rows below still apply.

| Change | Result |
|---|---|
| `wealth_positions.status` (`active`/`archived`) replaces the `_ARCHIVED` suffix in `record_type`; `CHECK` on `record_type` and `currency` | Archive state is a column, not string matching |
| Drop `wealth_investment_assets.display_name`, `price_currency`; keep `symbol` only for history-only assets (`CHECK`) | Asset holds pricing config only |
| Drop `wealth_transactions.account` after confirming the 45 unlinked rows are "unknown account" (`account_id IS NULL`) | Account name lives only in `wealth_accounts` |
| Make `wealth_price_history` the only price store; replace `wealth_market_prices` with a view of the latest row per asset | Latest price stored once |
| Credit-card outstanding becomes `wealth_accounts.current_balance` on the existing `credit_card` account rows; retire the LIABILITY position and the `liability` transaction kind | One balance per card, linked by FK |
| `wealth_recurring_obligations` becomes the single obligation table; mandate details move to `wealth_mandates (obligation_id PK/FK)`; `wealth_planned_bills` and `wealth_subscriptions` become views during transition; drop untyped `source_record_id` | One row per commitment |
| `wealth_interest_products (id, user_id, provider, product_key, account_id → accounts, position_id → positions)`; ledger, statements and rates reference `product_id`; drop text keys and `daily_breakdown` copies | Products named once, linked by FK |
| Drop `user_id` from pure children (`wealth_market_prices`, `wealth_price_history`, `wealth_payment_occurrences`) once queries join through the parent | No repeated ownership column where the FK already implies it |

## Rollout

Neon branch → audit clean → Development (approval) → verify dashboard totals unchanged to the paisa except intended fixes → Production (separate approval). Record each stage as a fix note under `docs/modules/database/`.
