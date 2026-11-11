# Database module

Neon PostgreSQL schema, migrations and the optional Redis cache.

## Connection

- [`api/_lib.js`](../../../api/_lib.js) uses `POSTGRES_URL` → `WEALTH_DATABASE_URL` → `DATABASE_URL`.
- Request handlers do not run DDL (`schema()` only checks configuration) — except `api/_routes/dashboard.js`, which still creates `wealth_category_symbols` on every request.

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
- Current files (0000–0010 applied to Development and Production as of 2026-11-11):

| File | Plan | Purpose |
|---|---|---|
| `0000_baseline` … `0005_link_obligations_and_interest` | Plan 1 | Baseline, session version, keys, account hierarchy, obligation/interest links |
| `0006_sync_legacy_to_v2` | Plan 2 B | Triggers keep v2 tables in step with every v1 write |
| `0007_job_runs_and_data_quality` | Plan 2 G | `wealth_job_runs` |
| `0008_plan3_data_quality_interest_obligations_audit` | Plan 3 | Duplicate marking, FD terms, price holds, interest links, obligations read model, `wealth_audit_log` |
| `0009_interest_credits_balance` | Plan 3 §14.1 | `credit_frequency`; balance status `estimated` |
| `0010_audit_changed_fields_only` | Plan 3 §14.4 | Audit stores only changed columns ([fix note](2026-11-11-store-only-required-data.md)) |
| `0011_broker_ledger` | 2026-11-11 | `wealth_broker_ledger`: broker funds ledger history ([fix note](../integrations/2026-11-11-angel-one-ledger-history.md)). Applied to Development; Production with the next `main` deploy |

- Backups: encrypted (`WLB1`, AES-256-GCM) via `scripts/db/backup-restore.mjs`; take one and pass the drill before applying a migration to Production.
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
