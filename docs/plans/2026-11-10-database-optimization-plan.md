# Database Optimization Plan

- **Date:** 2026-11-10
- **Status:** Proposed — nothing applied
- **Scope:** Neon schema, data integrity, query paths, migrations, retention
- **Evidence:** read-only audit of the database behind the `development` Preview deployment (`neondb`, ap-southeast-1); baseline schema in [`scripts/db/schema.sql`](../../scripts/db/schema.sql)

## Where we actually are

| Measure | Value | Meaning |
|---|---|---|
| Database size | 11 MB (wealth tables 2.1 MB) | Raw speed is not a problem. Optimizing for correctness and maintainability pays off far more than tuning. |
| Region | Vercel `sin1` ↔ Neon `ap-southeast-1` | Already co-located. No change needed. |
| Transactions | 594, dashboard loads `LIMIT 500` | **94 oldest transactions are silently missing from every spending statistic.** |
| Stock Advisor reports | 21 in 22 h, ~4 KB each | ~35 MB/year with no retention, mostly identical HOLD reports. |
| Seq scans on small tables | thousands | Expected at this size; the planner correctly prefers seq scans. Not a problem. |

Guiding rule: **every change must reduce a risk of wrong numbers, lost data or unrepeatable deploys.** No speculative indexing.

## Phase 0 — Safety net (prerequisite)

1. Create a Neon **branch** of the Development database for all trials; apply nothing to the main branch first.
2. Prove [`schema.sql`](../../scripts/db/schema.sql) rebuilds an empty branch; diff the result against the source.
3. Confirm whether the Preview database is shared with Production (compare hosts only). Every later phase depends on this answer.
4. Add a read-only `scripts/db/audit.mjs` that prints the integrity checks below; run it before and after every phase.

**Exit:** empty-branch rebuild succeeds; audit script committed; Dev/Prod database identity documented.

## Phase 1 — Versioned migrations (highest leverage)

Today `migrate-db.mjs` re-runs every data migration on every Production deploy, which **resets live Angel One prices** and **mutual-fund scheme codes** each time.

1. Add `wealth_schema_migrations(id text primary key, checksum text, applied_at timestamptz)`.
2. Rename files to an ordered scheme: `0000_baseline.sql` (= `schema.sql`), `0001_…`. Record existing ones as already applied.
3. Runner applies each file **once**, inside a real transaction (use Neon's WebSocket `Pool`, not per-statement HTTP calls), and refuses a changed checksum.
4. Replace the naive `;` splitter; stop stripping comments with broken regexes.
5. Move one-off data repairs (seed prices, archiving, hard-coded UUIDs) out of the deploy path into `scripts/db/repairs/` run manually with approval.
6. Bring the two manual migrations (`interest-source-registry`, `stock_advisor_reports`) under the runner.

**Exit:** two consecutive deploys leave `wealth_market_prices` and `wealth_investment_assets` unchanged.

> **Phases 2, 3 and 5 are superseded by the [Data normalization design](2026-11-10-data-normalization-design.md)**, which has measured duplication, PK/FK changes and drafted SQL. The tables below are kept for history.

## Phase 2 — Integrity constraints

| Change | Why |
|---|---|
| Add a `status` column (`active`/`archived`) on `wealth_positions`; stop encoding state as a `_ARCHIVED` suffix in `record_type` | Archive logic is string matching in SQL and JS today |
| `CHECK` on `wealth_positions.record_type` (known list) and `currency` (`INR`,`USD`) | Free text today; a typo silently drops a holding from totals |
| `UNIQUE (user_id, source_key)` on active positions | Migrations rely on `NOT EXISTS`; nothing prevents duplicates. Current `(user_id, source_snapshot_id, record_type, name)` index does not enforce when `source_snapshot_id` is NULL |
| Partial unique: one active `CREDIT_CARD` liability per card | Prevents a second outstanding balance doubling liabilities |
| `CHECK (quantity > 0)` where quantity is set; `CHECK (current_value >= 0)` | Guards valuation math |
| Drop `'CASA'` from the `category` check, or start using it | Unused value; CASA lives in `wealth_accounts` |
| Review `wealth_subscriptions_user_provider_uq (user_id, provider_key)` | Blocks two mandates from the same provider and makes the 3-column unique key redundant |

Apply each with `NOT VALID` → fix offending rows → `VALIDATE CONSTRAINT`, so nothing blocks on existing data.

## Phase 3 — Data clean-up (approval per item, Dev first)

| Finding | Proposed action |
|---|---|
| 5 exact-duplicate transactions | List them; user confirms; delete the extras |
| 45 transactions without `account_id`, 593 rows still using the legacy `account` text | Backfill `account_id` by matching the text to `wealth_accounts`; keep the text until the backfill is complete, then drop the column |
| Cancelled LIC / Slice auto-deposit bills still have `planned` payment occurrences | Cancel the occurrences; fix the cleanup migration to cascade |
| INDmoney buying power (₹941.18) lives only on an archived row | Move it to its own active record (e.g. `FOREIGN_CASH`) |
| US prices lack `fx_to_inr`, so INR always uses the saved 93.93 rate | Store FX on refresh; until then flag US INR values as reference-only |
| All 26 prices are hand-seeded and marked `fresh` | Mark seeded prices `manual`, not `fresh`; only the refresh job sets `fresh` |
| Angel One FD mandate has no `next_due_date`; LIC mandate is `monthly` vs a one-time bill | Confirm with the user and correct |

## Phase 4 — Query paths

1. **Stop truncating analytics.** Compute spend statistics (monthly totals, category totals, yearly averages) in SQL with `GROUP BY` over all rows and return them in the dashboard payload; keep `LIMIT 500` only for the visible transaction list (paginate it).
2. Remove `CREATE TABLE IF NOT EXISTS` from the `/api/dashboard` request path (move to migrations).
3. Return snapshots to the client only when an admin view needs them, not on every dashboard load (81 KB today, growing).
4. Keep the dashboard uncached (correctness rule); it is ~10 small queries on a 2 MB database.
5. Optionally move valuation into a single SQL view (`wealth_position_valuations`) so the API, tests and audit share one definition.

## Phase 5 — Indexes (small, evidence-based)

**Drop exact duplicates:**
- `wealth_investment_assets_position_id_uidx` (duplicates `wealth_investment_assets_position_id_key`)
- `wealth_category_symbols_user_category_uidx` (duplicates the primary key)
- `wealth_interest_rates_lookup_idx` (same columns as `wealth_interest_rates_period_uq`; btree scans either direction)
- `wealth_transactions_user_id_id_key` (`id` is already unique; nothing references the pair)

**Add for foreign keys used in cascades/joins:** `wealth_planned_bills(account_id)`, `wealth_subscriptions(source_account_id)`, `wealth_payment_occurrences(transaction_id)`, `wealth_email_imports(transaction_id)`, `wealth_market_prices(user_id)`.

At current size the gain is negligible; the point is fewer duplicate structures and safe cascades as data grows.

## Phase 6 — Retention and housekeeping

- Stock Advisor: keep every report for 30 days, then one per day; or skip saving when the recommendations are unchanged.
- `wealth_price_history`: keep all (small), but dedupe identical consecutive prices.
- `wealth_email_imports` (178 rows, 14 `needs_review`, no code uses it): decide owner and purpose, or archive.
- Snapshots: keep as the audit trail; never load all of them into the client.

## Verification for every phase

- Audit script clean (row counts, constraint checks, totals).
- Dashboard totals before vs after reconcile to the paisa, except where a fix intentionally changes them (documented).
- `npm run build` and tests pass.
- Fix note recorded under `docs/modules/database/` and indexed in [`docs/index.md`](../index.md).

## Approval gates

Per [Wealth Reliability & Data Integrity](../WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md): Neon branch → Development (approval) → Production (separate approval). No deletion or rewrite of financial records without the user confirming the specific rows.

## Suggested order and effort

| Order | Phase | Effort | Risk removed |
|---|---|---|---|
| 1 | 0 Safety net | 0.5 day | Unrecoverable mistakes |
| 2 | 1 Versioned migrations | 1 day | Prices reset on every deploy |
| 3 | 4.1 Untruncated analytics | 0.5 day | Wrong spending stats today |
| 4 | 3 Data clean-up | 0.5 day + user review | Wrong totals, phantom alerts |
| 5 | 2 Constraints | 1 day | Future duplicates and typos |
| 6 | 5 Indexes, 6 Retention | 0.5 day | Clutter and growth |
