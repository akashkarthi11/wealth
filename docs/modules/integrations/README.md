# Integrations module

External services: Angel One SmartAPI, Exa, Massive, and Stock Advisor report ingestion.

## Angel One SmartAPI — [`api/_routes/angel.js`](../../../api/_routes/angel.js)

- `GET /api/angel`, admin only, **read-only** (holdings, RMS, positions). No order calls, no DB writes.
- Logs in per request with client code, PIN and a TOTP generated server-side; no tokens persisted.
- Env: `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET`, `ANGEL_MAC_ADDRESS`. Missing vars → `setupRequired` response.
- Known issue: the base32 cleaner uses `/=|\\s/g`, so whitespace in the TOTP secret is not stripped and causes "Invalid ANGEL_TOTP_SECRET".

## Exa & Massive — [`api/_routes/providers.js`](../../../api/_routes/providers.js)

- `POST /api/providers`, admin only. Actions: `status`, `research` (Exa search, cached 15 min), `quote` (Massive US previous-session aggregate, cached 5 min).
- Env: `EXA_API_KEY`, `MASSIVE_API_KEY`. Keys never leave the server.
- Massive quotes are **US stocks only**; never use them to price Indian securities.

## Stock Advisor — [`api/_routes/stock-advisor.js`](../../../api/_routes/stock-advisor.js)

- `POST` (ingest): `Authorization: Bearer $WEALTH_ADVISOR_INGEST_SECRET` (≥ 32 chars, constant-time compare). Body needs `report_json` object plus `report_text` or `recommendations`. Saved against the first admin user.
- `GET`: latest report for the signed-in user (falls back to `wealth_snapshots` with a `stock-advisor` source) plus INR equity holdings.
- Table: `wealth_stock_advisor_reports` — migration [`20261110_stock_advisor_reports.sql`](../../../scripts/migrations/legacy/20261110_stock_advisor_reports.sql) is **manual**.
- UI: `stockAdvisorHtml` / `loadStockAdvisor` in [`app.js`](../../../app.js).
