# Wealth Android SMS bridge (starter)

This bridge is deliberately separate from the web app. It must be a user-installed Android app with explicit SMS permission, not an accessibility service and not a notification scraper.

## Security contract
- Request only RECEIVE_SMS (and READ_SMS only if the user explicitly enables the 90-day backfill).
- Filter sender IDs against a user-maintained allowlist of bank short codes / sender addresses.
- Exclude OTP, authentication, marketing and personal messages locally.
- Send only transaction candidates to `POST /api/ingest` over HTTPS with a per-device Bearer token created by the signed-in Wealth app.
- Store that token using Android Keystore-backed encrypted preferences.
- Never request contacts, call logs, accessibility, notification-listener, overlay, or payment permissions.
- Do not auto-read the entire inbox by default. The 90-day backfill requires a separate explicit in-app consent and local preview before sending.
- The API currently stages events only; it does not insert into wealth_transactions or alter balances.

## Runtime setup
The API must be deployed to a non-production preview with:
- `WEALTH_INGESTION_ENABLED=true`
- `WEALTH_INGESTION_DATABASE_URL` pointing exclusively to the isolated Neon transaction-ingestion-test branch

Production must not receive these variables. The bridge is not active until the preview endpoint and isolated database are verified.

## Payload
```json
{"source":"sms","externalId":"android-message-id","text":"Bank alert text","occurredAt":"2026-11-09T10:15:00+05:30"}
```
Do not log message bodies or the bearer token.
