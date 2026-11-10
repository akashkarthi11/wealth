# Database module

Neon PostgreSQL schema, migrations and the optional Redis cache.

## Connection

- [`api/_lib.js`](../../../api/_lib.js) uses `POSTGRES_URL` → `WEALTH_DATABASE_URL` → `DATABASE_URL`.
- Request handlers do not run DDL (`schema()` only checks configuration) — except `api/dashboard.js`, which still creates `wealth_category_symbols` on every request.

## Tables by module

| Module | Tables |
|---|---|
| Auth | `wealth_users` |
| Accounts | `wealth_accounts`, `wealth_transactions`, `wealth_snapshots`, `wealth_templates` |
| Investments | `wealth_positions`, `wealth_investment_assets`, `wealth_category_symbols` |
| Market data | `wealth_market_prices`, `wealth_price_history` |
| Interest | `wealth_interest_ledger`, `wealth_interest_statements`, `wealth_interest_rates`, `wealth_interest_sources` |
| Obligations | `wealth_planned_bills`, `wealth_subscriptions`, `wealth_recurring_obligations`, `wealth_payment_occurrences` |
| Integrations | `wealth_stock_advisor_reports` |

## Full schema script — [`scripts/db/schema.sql`](../../../scripts/db/schema.sql)

The core tables (`wealth_users`, `wealth_accounts`, `wealth_transactions`, `wealth_positions`, `wealth_snapshots`, …) were created by hand and no migration defines them. `schema.sql` is the complete structure of all 19 tables — columns, defaults, NOT NULL, primary/unique/check constraints, foreign keys and indexes — with **no data**.

- Idempotent (`IF NOT EXISTS`, guarded foreign keys), wrapped in one transaction.
- Use it to build a fresh database (new Neon branch, local Postgres, disaster recovery):
  `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/schema.sql`
- It contains `DO $$ … $$` blocks, so do not run it through `migrate-db.mjs`.
- Regenerate after any schema change (read-only against the catalog; never prints the URL):
  `npm run db:schema -- .env.preview.local`
- Snapshot taken 2026-11-10 from the database behind the `development` Preview deployment. `wealth_interest_sources` is absent because its migration was never applied there.

## Migrations — [`scripts/migrate-db.mjs`](../../../scripts/migrate-db.mjs)

Runs during `npm run build` on **Production builds only** (skipped on Vercel Preview and when no DB URL is set locally). Order:

1. Create/patch `wealth_category_symbols`, `wealth_investment_assets`, `wealth_market_prices`, `wealth_price_history` + indexes.
2. Backfill metal quantities; upsert investment assets for GOLD/SILVER/ETF/US_EQUITY.
3. `2026-11-10-recurring-obligations.sql`
4. `2026-11-10-angelone-ltp-price-history.sql`
5. `2026-11-10-convert-angelone-equity-to-live-positions.sql`
6. `2026-11-10-investment-position-normalization.sql`
7. `2026-11-10-reconcile-mandate-bill-duplicates.sql`
8. Seed default category symbols.

**Not run automatically:** `2026-11-10-interest-source-registry.sql`, `20261110_stock_advisor_reports.sql`.

SQL files are split on `;` and executed one statement per HTTP request (no real transaction).

## Redis cache

- Optional (`REDIS_URL`). Keys: `wealth:ledger:v1:<uid>` (20 s), `wealth:snapshots:v2:<uid>` (60 s), Exa/Massive provider caches.
- Stale-while-revalidate via `waitUntil()` with a per-user refresh lock.
- Dashboard responses are deliberately **not** cached.

## Known issues

- Migrations re-run on every Production deploy; two of them are not safely idempotent (they reset live prices and MF scheme codes — see [Market data](../market-data/README.md)).
- Several migrations hard-code user/position UUIDs.
- Comment/`BEGIN`/`COMMIT` stripping regexes in `migrate-db.mjs` (lines 36–38, 50, 66) are double-escaped and never match.
- The naive `;` split would break on any future SQL containing `;` inside strings or function bodies.
