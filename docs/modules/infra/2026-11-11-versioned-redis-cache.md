# Faster pages: versioned Redis cache — 2026-11-11

**Status:** in Production — `main` `35b2934` (build `4a`), migration 0018 applied; data version counting (4 after the reward repairs). Owner: "use redis more efficiently to increase speed of project".

## Before
- `/api/dashboard` (the heaviest call, ~12 queries in several sequential stages) was **never cached**: a stale-while-revalidate cache had once served totals that disagreed with the holdings list.
- `/api/ledger` (first page, 20 s) and `/api/snapshot` (60 s) used a time-based cache cleared by the app's own writes. Writes from outside the app (the ChatGPT task, direct SQL) did not clear it, so those pages could be stale until the TTL ran out.

## Design
- Migration [`0018_data_version.sql`](../../../scripts/migrations/0018_data_version.sql): `wealth_data_version` (one row). A statement-level trigger on every data table bumps `version` on any INSERT / UPDATE / DELETE — from the app, cron or external SQL. Log/bookkeeping tables (audit log, job runs, sync issues, migrations) are left out.
- `api/_lib.js`:
  - `sessionAndVersion(req)`: the session check and the data version in **one** query.
  - `cachedForUser(req, name, compute, {variant, ttl})`: Redis GET runs **in parallel** with that query; a cached entry `{v, d}` is used only when `v` equals the current version; otherwise `compute` runs and the entry is written **after** the response (`waitUntil`). TTL 10 min caps any entry.
  - `cachedValue(uid, …)` for handlers that already authorised (`handle()`): version + Redis in parallel, same rule.
  - `X-Wealth-Cache: hit|miss` header for checking.
- Redis stays optional and fail-open (1 s limit, 30 s cool-down): any Redis problem = a normal miss.

## Where
| Route | Key variant | Notes |
|---|---|---|
| `/api/dashboard` | model choice + dashboard model + IST day | miss path now runs every query in parallel (owner-only parts dropped for other roles) |
| `/api/ledger` (first page) | — | replaces the 20 s SWR cache |
| `/api/snapshot` | — | owner check inside the cached build |
| `/api/account-detail` | account id + IST day | |
| `/api/rewards` | IST day | |
| `/api/interest` | IST day | |
The IST day in a key makes month-to-date / "today" figures roll over at midnight even without writes.

## Measured (read-only, from the owner's PC to the Singapore database — Vercel is closer, so all numbers are lower there)
| Path | Median of 5 |
|---|---|
| Old dashboard (staged queries, no cache) | 1,809 ms |
| New dashboard, cache miss (all parallel) | 1,096 ms |
| New dashboard, cache hit (version query ‖ Redis) | ~118 ms + Redis GET |

## Tests
`scripts/tests/cache.test.mjs` (version bumps once per write statement from any writer, reads and log tables do not; routes use the helpers; one-query session+version; served only on a version match; write after response). `dashboard-model.test.mjs` updated. Full suite 170/170. Development: 0018 applied (19 migrations).

## Redis location (2026-11-11)
- Store `redis-chestnut-brush` (Redis Cloud, Free 30 MB) is in **Mumbai (`bom1`)**; Vercel functions run in **Singapore (`sin1`)**, Neon in ap-southeast-1. Each Redis call crosses Singapore↔Mumbai (~30–60 ms).
- Upstash in Singapore was tried from the CLI but needs a paid checkout — owner: "not free"; not created.
- Free option left to the owner: a Redis Cloud Free store in Singapore from the Vercel dashboard, then move `wealth` to it (the old store stays for `growx-mindrelax`). Until then the cache runs on the Mumbai store.
