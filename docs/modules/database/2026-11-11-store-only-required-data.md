# 2026-11-11 — Store only required data (audit log, price history, estimated balances)

- **Status:** deployed and verified in Production (`main` `2a2afde`; `/api/health` latest migration `0010_audit_changed_fields_only`)
- **Plan:** [Claude Plan 3 §14.4](../../plans/claude-plan-3.md)
- **Owner rule:** "store only required data, don't save waste data". No existing rows were deleted.

## Problem

| Where | Waste |
|---|---|
| `wealth_audit_log` | Every update stored the full before and after rows, including updates that changed only `updated_at` |
| `wealth_price_history` | Written by every price refresh, never read. `wealth_instrument_prices` already keeps one row per new quote |
| `wealth_account_balances` | The nightly interest run added a new `estimated` row every night |

## Resolution (commit `501bcab`)

- Migration [`0010_audit_changed_fields_only.sql`](../../../scripts/migrations/0010_audit_changed_fields_only.sql) replaces `wealth_trg_audit()`. On update it stores only the changed columns in `before` and `after`, and records nothing if only `updated_at` changed. Inserts and deletes are unchanged. Auditing still never blocks the write.
- `storePrices` (`api/_ingest.js`) and the refresh job stop writing `wealth_price_history`. The table and its rows are kept.
- `runAccrual` (`api/_interest.js`) moves one rolling estimated row forward per account. It never updates a row older than the last verified balance, and never touches verified rows.

## Verification

- Before 0010 on Production: an encrypted backup (`prod-before-0010.wlb`, 1,332 rows) passed the restore drill.
- `plan3.test.mjs` "no waste: prices are not copied …": an `updated_at`-only update writes no audit row; a real change records only the changed keys; one estimated row after two nightly runs.
- 110 tests pass.

## Follow-up

- The **old** hourly agent prompt still writes `wealth_price_history` until it is switched to the new API prompt (Plan 3 §14.6).
