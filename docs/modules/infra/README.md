# Infrastructure module

Deployment, build, CI and environment configuration.

## Hosting

- Vercel project `wealth`; serverless functions in `api/` (Node 20+, region `sin1`, `maxDuration` 10 s).
- Static files: `index.html`, `app.js`, `style.css` — copied to `public/` by the build.
- Security headers on all routes: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`. API and `/` are `no-store`.
- Cron: `/api/refresh-market-prices` daily at 23:00 UTC.

## Build — `npm run build`

1. [`scripts/validate-homepage.mjs`](../../../scripts/validate-homepage.mjs): `node --check app.js`; every `$('id')` used in `app.js` exists in `index.html` (or the runtime-generated allow-list); required elements present; copy assets to `public/`.
2. [`scripts/migrate-db.mjs`](../../../scripts/migrate-db.mjs) (Production only).

Tests: `npm run test:us-valuation`.

## Branches

- `main` — production. `development` — development/preview. Feature branches → PR to `development`.
- `fix/net-worth-valuation-reconciliation` adds a GitHub Actions workflow that runs validation and tests on PRs to `development` only.

## Environment variables

| Variable | Used by |
|---|---|
| `WEALTH_DATABASE_URL` / `POSTGRES_URL` / `DATABASE_URL` | All APIs, migrations |
| `WEALTH_SESSION_SECRET` (≥ 32) | Sessions |
| `WEALTH_ACCESS_KEY` | Register / forgot password |
| `REDIS_URL` | Optional cache |
| `CRON_SECRET` | Market-price refresh |
| `WEALTH_ADVISOR_INGEST_SECRET` (≥ 32) | Stock Advisor ingest |
| `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET`, `ANGEL_MAC_ADDRESS` | Angel One |
| `EXA_API_KEY`, `MASSIVE_API_KEY` | Providers |

Secrets live only in Vercel Environment Variables — never in Git or browser code.

## Release rule

**No deployment to Development or Production without explicit approval for that specific target.** See [Wealth Reliability & Data Integrity](../../WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md).

## Client update prompt

`APP_BUILD_ID` in `app.js` triggers a "new version available — reload?" prompt when it changes; bump it with every client release.

## Environments and health check (2026-11-10)

Two Vercel teams deploy this repository. The code behaves the same on every deployment:

| Deployment | Vercel team | Database | Migrations on build |
|---|---|---|---|
| Production (`main`) | `karthi-4a8f` | Production (`ep-solitary-quee…`) | yes |
| Preview (any branch) | `karthi-4a8f` | **the same Production database** | no (would touch live data) |
| Preview of `claude-dev` | `development-b9bc` | Development (`ep-noisy-bread…`) | only with `WEALTH_MIGRATIONS=on` |

- **Database URL:** the first of `POSTGRES_URL`, `WEALTH_DATABASE_URL`, `DATABASE_URL` that holds a real `postgres://` URL. Empty values and `[SENSITIVE]` placeholders are skipped.
- **`REDIS_URL`:** optional; used only if it is a `redis://`/`rediss://` URL. Every Redis call is time-limited and fails open.
- **`/api/health`:** open it on any deployment to see which settings it has (yes/no only, never values), whether the database answers, and the latest migration. Returns 503 when login cannot work.
- **Login** returns 503 with the missing setting's name when the deployment is not configured.

Required per deployment: `WEALTH_SESSION_SECRET` (≥ 32 characters), a database URL, `WEALTH_ACCESS_KEY` (registration), `CRON_SECRET` (Production; Vercel Cron sends it to `/api/refresh-market-prices`).

Checked 2026-11-10: Production lacks `CRON_SECRET`; the development team's settings (as known locally) lack `WEALTH_SESSION_SECRET` and `WEALTH_ACCESS_KEY`.
