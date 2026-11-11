# 2026-11-11 — Production deploy failed: more than 12 functions on the Hobby plan

**Status:** code committed on `claude-dev`, tests passed (102). Not deployed. Production still serves the build from before the `main` merge `45e4b96`.
**Status update 2026-11-11:** merged to `main` (`696a71d`, PR #43/#44) and **deployed to Production**; every later `main` deploy (latest `2a2afde`) succeeded with one function, `api/router.js`.

## Symptoms

- The Production deployment of `main` at `45e4b96` (`wealth-mmrw4ccf2-…`) ended in **Error** after "Build Completed … Deploying outputs…".
- During that build, tests passed and the build step applied migration `0007_job_runs_and_data_quality` to the Production database.
- The site kept serving the previous deployment (`wealth-lc9ua8zhc-…`). `/api/health` reported `migrationsApplied: 8` and `CRON_SECRET missing`. The secret was added after that deployment, so the running build does not have it.

## Root cause

- **Confirmed:** the main Vercel team (`karthi-4a8f`) is on the Hobby plan, which allows at most **12 Serverless Functions per deployment**.
  - Every non-underscore file in `api/` is one function.
  - The last successful build had 12 functions. The merge added `api/data-quality.js` and `api/reconcile.js`, making 14.
- Plan 3 adds about 10 more endpoints, so splitting files further is not an option.

## Resolution

- **One function.** Every handler moved to `api/_routes/<name>.js`; Vercel does not deploy underscore folders as functions.
  - `api/router.js` is the only function, and `vercel.json` rewrites `/api/<path>` to `/api/router?__route=<path>`.
  - The router restores the original path and query before calling the handler, so URLs, methods and responses are unchanged.
  - Handlers are loaded lazily by literal import, so each one is bundled but only loaded when first used.
- **Crons:** at most two on Hobby. `/api/refresh-market-prices` is unchanged; the new `/api/nightly` runs interest accrual and the backup. They are one entry, not two.
- **Test** (`plan3.test.mjs`, router test):
  - `vercel.json` declares exactly one function and at most two crons;
  - every cron path is routed;
  - every route module loads.

## Data

None changed by this fix. Migration 0007, applied by the failed build, is additive: two empty tables.

## Verification still needed

After an approved deploy:

- confirm the deployment is **Ready**;
- `/api/health` returns 200 through the rewrite;
- sign-in works;
- `CRON_SECRET` shows as present.

## Follow-ups

- The same limit applies to the Development team (`development-b9bc`, also Hobby).
- Upgrading to Pro would remove both limits; nothing in the code depends on that.
