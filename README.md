# Karthi Wealth Ledger

Standalone Vercel app. Required environment variables:
- `WEALTH_DATABASE_URL`: Neon PostgreSQL connection string
- `WEALTH_SESSION_SECRET`: random secret with at least 32 characters

Optional Redis cache (Upstash):
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The app uses Upstash Redis for short-lived, per-user caching of authenticated ledger and snapshot GET responses. Ledger cache entries expire after 20 seconds and are invalidated after successful inserts/deletes; snapshot cache entries expire after 60 seconds. Cache keys are scoped to the authenticated user. If Redis variables are absent or Redis is temporarily unavailable, requests fall back to Neon directly.

Deploy from this repository root, Node.js 20+. API routes initialize the wealth tables. Do not commit database URLs, Redis tokens, session secrets, or personal financial snapshots to GitHub.


## Angel One SmartAPI (read-only integration)

Optional Vercel environment variables (configure in Project Settings; never commit values):
- `ANGEL_API_KEY`
- `ANGEL_CLIENT_CODE`
- `ANGEL_PIN`
- `ANGEL_TOTP_SECRET` (authenticator TOTP seed; not the six-digit current code)
- `ANGEL_MAC_ADDRESS` (MAC address value accepted by SmartAPI)

The admin-only `GET /api/angel` endpoint authenticates with SmartAPI and reads all holdings, RMS funds/margins, and positions. It is deliberately GET-only: no order, modify, cancel, or database-write calls. Until all five environment variables are configured it reports which settings are missing. SmartAPI sessions are currently created per invocation; no broker tokens are persisted. Configure secrets only in Vercel Environment Variables, never in Git or browser code.


## Exa and Massive (server-side provider adapters)

Configure these Vercel Environment Variables for Production and Preview:
- `EXA_API_KEY` — Exa search API key
- `MASSIVE_API_KEY` — Massive API key

The owner/admin-only `POST /api/providers` endpoint supports:
- `{"action":"status"}` — reports whether provider keys are configured (never returns key values).
- `{"action":"research","query":"..."}` — runs Exa search and returns source titles, URLs, publication dates, and short text extracts. Results are cached in Redis for 15 minutes.
- `{"action":"quote","ticker":"AAPL"}` — requests the previous trading session aggregate from Massive's US Stocks endpoint. Results are cached in Redis for 5 minutes. This route explicitly identifies USD and US Stocks; it must not be used to price Indian-listed securities.

Both providers are called only from the server. Keys are read from environment variables and are never sent to the browser or stored in Neon. Indian equity prices must use an appropriate India-supported source and must not be inferred from a Massive US ticker response. The adapter returns setup-required status when keys are absent.


## Kafka cache refresh worker

The UI uses Redis as a fast read cache. A cache hit is returned immediately and
publishes a deduplicated Kafka refresh event. A separate long-running worker reads
the latest records from Neon and refreshes the Redis entry. Cache misses are read
from Neon by the API and populated directly. Neon remains authoritative; successful
writes invalidate affected caches.

Required environment variables for the Vercel API and worker:
- `WEALTH_DATABASE_URL` (or `POSTGRES_URL` / `DATABASE_URL`)
- `REDIS_URL`
- `KAFKA_BROKERS` — comma-separated broker host:port list
- `KAFKA_USERNAME`
- `KAFKA_PASSWORD`
- `KAFKA_SASL_MECHANISM` — usually `plain` or `scram-sha-256` / `scram-sha-512`
- `KAFKA_SSL` — defaults to `true` (set `false` only for a trusted private network)

Optional:
- `KAFKA_CLIENT_ID` (defaults to `wealth-api`)
- `KAFKA_CACHE_REFRESH_TOPIC` (defaults to `wealth.cache.refresh.v1`)
- `KAFKA_GROUP_ID` (worker defaults to `wealth-cache-refresh-v1`)

Run the worker as a persistent Node.js 20+ service (not as a Vercel Function):
`npm install && npm run worker`

The worker creates the refresh topic through the Kafka broker's auto-topic-creation
setting if enabled; otherwise create `wealth.cache.refresh.v1` with one or more
partitions before starting it. It uses a per-user cache key and refreshes dashboard,
ledger, or admin snapshots. Duplicate events are safe to process. If Kafka is not
configured in the API, requests continue using Neon/Redis synchronously and no
Kafka events are published.
