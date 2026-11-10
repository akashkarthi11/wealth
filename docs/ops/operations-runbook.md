# Operations runbook (TSD Claude Plan 3, Phase 6)

These steps are for the project owner. Each one is a setting in Vercel or a command run on the owner's machine.
The app never reads or prints secret values: `/api/health` only says whether each setting is present.

## 1. Settings

| Setting | Where | Purpose | Without it |
|---|---|---|---|
| `CRON_SECRET` (≥ 16) | Production | Vercel Cron calls `/api/refresh-market-prices` (23:00 UTC) and `/api/nightly` (20:00 UTC) | Both crons get 401 |
| `WEALTH_INGEST_SECRET` (≥ 32) | Production + agents | Bearer token for the agents: prices, Gmail imports, balances, rates, accrual run, credits, Stock Advisor | Agents can't use the APIs |
| `WEALTH_BACKUP_KEY` (≥ 32) | Production; **also keep an offline copy** | Encrypts every backup (AES-256-GCM) | Backups are not stored |
| `BLOB_READ_WRITE_TOKEN` | Production (set automatically when a Blob store is connected) | Off-site storage for the backups | Backups are not stored |
| `WEALTH_METAL_PRICE_SOURCE` | Optional | `futures` = daily refresh prices gold/silver from GC=F/SI=F. Unset = India benchmark from the hourly agent (default, DV3-2) | — |

Generate a secret locally:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 2. Backups (TR3-6.1)

**Setup, once**

1. Vercel → project `wealth` → Storage → Create → **Blob**, access **Private**.
2. Connect it to the project for **Production only**. This adds `BLOB_READ_WRITE_TOKEN`.
3. Add `WEALTH_BACKUP_KEY` (Production only) and store the same value in your password manager. **A backup cannot be read without the key it was made with.**
4. Redeploy Production.

**What runs**

- Every night at 01:30 IST, `/api/nightly` exports every `wealth_*` table in one consistent read.
- The export is gzipped, encrypted, and written to `backups/wealth-production-<time>-<random>.wlb`.
- The run is recorded in `wealth_job_runs` (job `backup`).
- `/api/health` and the Data quality page report a missing, stale (> 36 h) or failed backup.
- The app never deletes a backup. Retention is the owner's decision (DV3-4). Remove old files in the Blob store when you choose.

**Manual backup** (read-only on the source):

```
node scripts/db/backup-restore.mjs backup .env.production.local backup.wlb --key-env <file with WEALTH_BACKUP_KEY=…>
```

## 3. Restore drill (test that a backup can be restored)

Restores into a fresh in-memory database with every migration applied. Nothing real is touched.

```
node scripts/db/backup-restore.mjs drill backup.wlb --key-env <key file>
```

Expected output: `restored N tables, M rows … all counts match`. Tables that exist in the backup but not in the migrated schema are listed by name; they stay in the backup file.

- **Last drill:** 2026-11-11, on a Development backup taken just before migration 0008.
  - 29 tables and 1,218 rows restored; all counts matched.
  - `wealth_interest_sources` (0 rows) exists only in Development and is not part of any migration.

**Real restore** (non-production only; replaces the target's rows; the tool refuses a Production env file):

```
node scripts/db/backup-restore.mjs restore backup.wlb .env.devteam.local --key-env <key file>              # dry run
node scripts/db/backup-restore.mjs restore backup.wlb .env.devteam.local --key-env <key file> --apply --yes
```

Restoring Production is a deliberate, owner-approved operation:

1. Restore into a Neon branch.
2. Verify it.
3. Promote the branch.

The tool does not do this.

## 4. Audit trail (TR3-6.2)

- `wealth_audit_log` records every insert, update and delete on accounts, balances, holdings, positions, transactions, interest rates and the interest ledger. Each row stores the before and after values and the actor:
  - `owner`, `agent` or `cron` for writes made through the API;
  - `external` for direct SQL.
- Rows are never deleted by the app.

```sql
SELECT at, actor, action, row_id, before, after FROM wealth_audit_log
WHERE table_name = 'wealth_holdings' ORDER BY at DESC LIMIT 20;
```

## 5. Environments (TR3-6.3)

The main team's Preview deployments use the **Production** database today. To separate them:

1. Vercel → project `wealth` (team `karthi-4a8f`) → Settings → Environment Variables.
2. For the **Preview** environment only, set `POSTGRES_URL` to the **Development** database URL (Neon project cold-smoke-05088150). If the Neon integration manages `POSTGRES_URL` for Preview, turn off its Preview sync first.
3. Optionally set `WEALTH_MIGRATIONS=on` for Preview, so Preview builds apply migrations to Development.
4. Keep `CRON_SECRET`, `WEALTH_INGEST_SECRET`, `WEALTH_BACKUP_KEY` and `BLOB_READ_WRITE_TOKEN` in **Production only**.

Preview needs its own `WEALTH_SESSION_SECRET` and `WEALTH_ACCESS_KEY`. Today they are shared with Production.

The Development team (`development-b9bc`) still needs `WEALTH_SESSION_SECRET` and `WEALTH_ACCESS_KEY` in its Preview environment, or sign-in fails there.

## 6. Key rotation (TR3-6.4)

| Secret | How | Effect |
|---|---|---|
| `WEALTH_SESSION_SECRET` | Set a new value (≥ 32), redeploy | **Everyone is signed out** (all cookies become invalid). To sign out a single user instead, increase their `session_version` (owner password reset does this) |
| `WEALTH_INGEST_SECRET` | Set the new value in Vercel and in both scheduled agents, then redeploy | Agents get 401 until both sides match. Rotate during a quiet hour |
| `CRON_SECRET` | Set a new value, redeploy | Vercel Cron sends the new value automatically |
| `WEALTH_BACKUP_KEY` | Set a new value, redeploy | New backups use the new key. **Keep the old key**: older backups still need it |
| Database password | Neon → Roles → reset, then update `POSTGRES_URL` everywhere | Every deployment and agent must be updated together |

## 7. Single-function routing (Hobby plan)

- All `/api/*` URLs are served by `api/router.js` (see [the fix record](../modules/infra/2026-11-11-hobby-function-limit-single-router.md)).
- To add an endpoint:
  1. add `api/_routes/<name>.js`;
  2. add one line to `ROUTES` in `api/router.js`.
- Never add another non-underscore file under `api/`.
