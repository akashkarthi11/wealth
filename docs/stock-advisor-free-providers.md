# Wealth Stock Advisor — Free provider policy

This document describes the provider adapters used by the existing Stock Advisor. It does not create a second research system or database.

## Market and company evidence

| Provider | Purpose | Authentication | Guardrails |
|---|---|---|---|
| TejHQ | NSE end-of-day OHLCV and price history | No key for the current endpoint | EOD only; not an intraday quote. Personal-use terms apply. |
| MFAPI.in | Indian mutual fund NAV history | No key | Scheme identity must be resolved by saved AMFI scheme code or a sufficiently close name match. |
| NSE RSS | Announcements, results, annual reports, board meetings, shareholding patterns and corporate actions | No key | RSS entries are listings only and remain unverified until the linked filing content is checked. |
| Fincrux Hobby | Structured quarterly/annual financial data | `FINCRUX_API_KEY` | Five requests per IST day. One stored snapshot is reused for 30 days. Third-party data remains unverified until corroborated against official filings. |

### Fincrux setup

Add `FINCRUX_API_KEY` only to the Development Preview environment. Never commit the key or include it in stored source URLs or logs.

The collector reserves each daily request in the existing `wealth_stock_advisor_research_sources` table under a Postgres advisory lock. Failed attempts count toward the five-request daily allowance. No separate quota table is created.

The Fincrux response is stored as `financial_statement` with `verification_status='unverified'`. This is deliberate: the provider documents that its forced refresh scrapes Screener data, so its figures must not independently unlock the evidence gate.

## AI fallback

- Primary: the existing NVIDIA Nemotron Free route through Vercel AI Gateway.
- Optional fallback: Groq free-plan `openai/gpt-oss-20b`.
- Groq fallback requires both `GROQ_API_KEY` and `GROQ_ZERO_DATA_RETENTION_CONFIRMED=true`.
- Set the confirmation flag only after enabling Global Zero Data Retention in the Groq console. Groq's standard retention may otherwise be up to 30 days.
- Gemini Free is intentionally not an automatic fallback: Google's current free-tier terms say submitted content may be used to improve its products. The Stock Advisor prompt can contain private portfolio context.

The app never selects a paid model intentionally. If neither configured free provider is available, the debate remains queued/retryable rather than fabricating a response.

## Evidence policy

1. A provider response is not automatically a verified fact.
2. Exchange RSS entries are `unverified` until the linked filing content is checked.
3. Fincrux structured statements are `unverified` until corroborated against official exchange/company filings.
4. The existing equity evidence gate still requires verified `market_price`, `financial_statement` and `technical_indicator` evidence.
5. Missing essential evidence keeps the CIO decision at `DATA REQUIRED`.
6. Every source is stored in the existing research-source table and every price in the existing price-history table. No duplicate research or price tables are introduced.

## Environment scope

Provider secrets and optional fallback settings must be configured only in the Development Preview environment while this work is being tested. Do not copy them to Production as part of this implementation.
