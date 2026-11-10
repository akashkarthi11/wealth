# Versioned migrations, owner keys, account hierarchy and linked obligations/interest

- **Date:** 2026-11-10
- **Primary module:** Database
- **Related modules:** Market data, Investments, Dashboard, Obligations, Interest
- **Status:** Code and migrations committed on `claude-dev` (`eae5131`, `83b00ff`, `49f9704`, `6d28265`, `177dd01`). **Migrations 0000–0005 applied to Development and Production on 2026-11-10** at the owner's request (backups taken first). Application code not deployed; `WEALTH_DATA_MODEL` still `v1`
- **TSD:** [Claude Plan 1](../../plans/claude-plan-1.md) Phases 2, 4, 5, 6 — defects DEF-03, DEF-04, DEF-06, DEF-07, DEF-08, DEF-11, DEF-12, DEF-13

## Symptoms

- Every Production deploy re-ran data migrations that overwrote live Angel One prices with old snapshot prices marked `fresh`, and reset mutual-fund scheme codes.
- No migration created the core tables; `/api/dashboard` ran `CREATE TABLE` per request.
- The same facts were stored 2–3 times (credit-card balance, FD as account and positions, per-user asset copies, latest price in two tables) and child rows could reference another user's parent.
- INDmoney cash lived only on an archived row; active mandates pointed at cancelled obligations; interest products were identified by inconsistently spelled text.

## Resolution

| Migration / change | Effect |
|---|---|
| `scripts/migrate-db.mjs` + `scripts/db/migrations-lib.mjs` | Each `NNNN_*.sql` runs once, in one transaction, with a checksum; editing an applied file fails the build; advisory lock; `--dry-run` writes nothing |
| Legacy data migrations → `scripts/migrations/legacy/` | No longer run on deploy (fixes DEF-03, DEF-04) |
| `0000_baseline` | Full schema from the live catalog; rebuilds an empty database |
| `0002_owner_keys` | `(user_id, id)` composite FKs on 13 relations, unique active holding, unique advisor run, `transactions.external_ref`; drops 5 duplicate indexes and 13 redundant FKs |
| `0003_account_hierarchy` | Subtypes (CASA / INVESTMENT / LIABILITY), shared instruments and prices, holdings, balances, views |
| `0004_account_hierarchy_backfill` | Copies legacy data; aborts if anything is not carried over; card outstanding → card account; INDmoney cash → INDmoney account; duplicate FD account marked `merged` |
| `0005_link_obligations_and_interest` | `planned_bills.obligation_id`, `payment_occurrences.planned_bill_id`, `wealth_interest_products` + `product_id`, `interest_ledger.account_id`; triggers keep external writers linked |
| `scripts/db/repairs/` | Manual, approved data repairs: stage-2 re-link (old values kept in notes), close duplicate rate, mark seeded prices `manual`. No deletes |
| No-data-deletion guard | `migrations-lib.mjs` refuses any migration with `DELETE`, `TRUNCATE` or `DROP TABLE/COLUMN/VIEW`; `no-data-deletion.test.mjs` also checks the repairs |
| `scripts/db/run-sql.mjs` | Read-only by default; `--apply --yes` to write |

## Verification

- [x] PGlite: fresh build, idempotent re-run, checksum guard, rollback on failure, owner FKs, unique keys, duplicate indexes gone, backfill idempotent and aborting, obligation/interest linking and triggers (`scripts/tests/*.test.mjs`, 58 tests).
- [x] In-memory copy of the Preview data: 0002–0005 apply cleanly; v2 totals reproduce every v1 figure except US holdings, which are excluded as missing FX until the refresh job stores a USD/INR rate.
- [x] Dry run against the Preview database lists pending migrations and changes nothing.
- [x] **Development** (`ep-noisy-bread…`, `.env.devteam.local`), 2026-11-10 ~17:55 UTC. Backup: `.db-backups/claude-development-before-migrations-20261110T175351Z`. First attempt of 0000 failed and rolled back: the database had lost 58 constraints (no primary keys on 10 tables). 0000 was extended to restore missing PK/UNIQUE/CHECK constraints (`177dd01`), then 0000–0005 applied. Verified read-only: no rows lost, every table has a primary key, v2 net worth ₹4,55,475.67.
- [x] **Production** (`ep-solitary-quee…`; also used by Preview deployments), 2026-11-10 ~17:58 UTC. Backup: `.db-backups/claude-production-before-migrations-20261110T175731Z`. 0000–0005 applied. Verified read-only: no rows lost, every table has a primary key, 15 accounts / 26 holdings / 10 balances, v2 net worth ₹4,55,475.67 (US holdings excluded as missing FX until the refresh job stores a USD/INR rate).
- [x] Compatible with the code currently deployed (v1): migrations only add tables, columns, keys and triggers.
- [ ] Deploy the application code (separate approval), then switch `WEALTH_DATA_MODEL=v2` after comparing `?model=v2`.
- [ ] Optional repairs in `scripts/db/repairs/` (separate approval).

## Rollout notes

- The first deploy that runs the new runner applies `0000`–`0005` in order. `0000` is idempotent on an existing database.
- `WEALTH_DATA_MODEL` stays `v1` until the owner signs off; the owner can preview v2 with `?model=v2` or the "Preview account model" link in More.
- **Owner rule: no data is deleted.** Legacy tables, the `transactions.account` column, copied metadata, the advisor snapshot copy, the merged FD account row and identical transaction pairs all stay. The new model reads only canonical rows, so the copies no longer affect totals.
- Not done: converting bills/subscriptions to views (external writers unknown).
- Repair run on the in-memory copy: every table's row count is identical before and after.
