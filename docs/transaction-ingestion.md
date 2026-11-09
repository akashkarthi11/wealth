# Transaction ingestion — staged rollout

## Current safety boundary
The ingestion API is feature-flagged off by default and uses a separate `WEALTH_INGESTION_DATABASE_URL`. The database must point to Neon branch `transaction-ingestion-test`; never point it at the production branch. Incoming SMS/email records are written only to `wealth_ingestion_events` with status `staged`. No code path writes to `wealth_transactions`, balances, snapshots, or spending totals.

## Endpoints
- `POST /api/ingestion-token`: signed-in user only; creates a one-time device token. Requires the feature flag and isolated DB. Store the returned token in Android Keystore.
- `POST /api/ingest`: Bearer device token; accepts `source=sms|email`, `externalId`, and message text. OTP / non-transaction messages are ignored. Idempotency uses source + external ID and a content hash.

## Gmail
The app's Gmail connector is available inside ChatGPT, but it is not an OAuth credential that the standalone Wealth server can reuse. A direct Gmail sync requires a Google Cloud OAuth client with the minimum Gmail read-only scope, a user consent flow, encrypted refresh-token storage, and a restricted mailbox query. Do not ask for or store a Gmail password or app password. The first 90-day historical pass should be a dry-run: extract transaction candidates, deduplicate against SMS, then stage them only after the user verifies the sample.

## Android
The bridge starter specification is in `android-sms-bridge/README.md`. Android SMS access is sensitive/restricted; implement a clear permission disclosure, sender allowlist, local OTP filter, explicit 90-day backfill consent, and Keystore token storage. No accessibility or notification-listener workaround.

## Release gates
1. Create isolated Neon branch and verify its schema.
2. Configure preview-only environment variables; production must have no ingestion flag, DB URL, or device tokens.
3. Add Gmail OAuth read-only flow; validate sender allowlist and query limits.
4. Build/install Android bridge and verify one synthetic SMS.
5. Test duplicates, refunds, transfers, unknown senders, malformed amounts, timezone and OTP filtering.
6. Reconcile staged records against source messages and existing ledger before enabling any ledger writes.
