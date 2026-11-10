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

> Updated 2026-11-10 on `claude-dev`: versioned runner. See [fix note](2026-11-10-versioned-migrations-and-keys.md).

Runs during `npm run build` on **Production builds only** (skipped on Vercel Preview and when no DB URL is set locally).

- Applies each `scripts/migrations/NNNN_name.sql` **once**, in order, inside one transaction (Neon `Pool` over WebSocket), recorded in `wealth_schema_migrations` with a SHA-256 checksum. An edited, already-applied file fails the build. Files must not contain `BEGIN`/`COMMIT`.
- `npm run db:migrate:dry` lists pending files and writes nothing.
- Current files: `0000_baseline`, `0001_session_version`, `0002_owner_keys`, `0003_account_hierarchy`, `0004_account_hierarchy_backfill`, `0005_link_obligations_and_interest`.
- The old data migrations are archived in `scripts/migrations/legacy/` and no longer run.
- **Data repairs** live in `scripts/db/repairs/` and run manually with owner approval: `node scripts/db/run-sql.mjs <env-file> <file> --apply --yes` (read-only without `--apply`).
- Tests run every migration on in-memory Postgres (PGlite): `npm test`.

## Redis cache

- Optional (`REDIS_URL`). Keys: `wealth:ledger:v2:<uid>` (first page, 20 s), `wealth:snapshots:v2:<uid>` (60 s), `wealth:rl:*` (login rate limits), Exa/Massive provider caches.
- Stale-while-revalidate via `waitUntil()` with a per-user refresh lock.
- Dashboard responses are deliberately **not** cached.

## Known issues

- Production is PostgreSQL 18 on Neon; migration tests run on PGlite (PostgreSQL 16). Features used are available in both.
- Legacy tables (`wealth_positions`, `wealth_investment_assets`, `wealth_market_prices`, `wealth_price_history`) remain until the v2 model is signed off and their removal approved.
