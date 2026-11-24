# Wealth Stock Advisor — Free provider policy

This document describes the provider adapters used by the existing Stock Advisor. It does not create a second research system or database.

## Market and company evidence

| Provider | Purpose | Authentication | Guardrails |
|---|---|---|---|
| TejHQ | NSE end-of-day OHLCV and price history | No key for the current endpoint | EOD only; not an intraday quote. Personal-use terms apply. |
| MFAPI.in | Indian mutual fund NAV history | No key | Scheme identity must be resolved by saved AMFI scheme code or a sufficiently close name match. |
| NSE RSS | Announcements, results, annual reports, board meetings, shareholding patterns and corporate actions | No key | RSS entries are listings only and remain unverified until the linked filing content is checked. |
| Fincrux Hobby | Structured quarterly/annual financial data | `FINCRUX_API_KEY` | Five requests per account per IST day. With two separate Hobby accounts, the combined allowance is ten requests. One stored snapshot is reused for 30 days. Third-party data remains unverified until corroborated against official filings. |
| Agent web | Official pages a debate agent opens for itself | No key | Allowlisted hosts only: NSE, BSE, SEBI, AMFI, RBI, Yahoo. A refused URL makes no request. Text is returned as unverified context and never satisfies missing evidence. |
| Web search (Tavily) | Free web search a debate agent may call for context | `TAVILY_API_KEY` | Offered to the agents only when the key is set. Thirty searches per IST day out of a free monthly allowance, counted from the API audit and refused before a credit is spent. Results are unverified context and can never unlock a BUY, HOLD or SELL. |

## Agent-collected data (2026-11-24)

Until this change the agents could only argue over whatever the nightly job had gathered. They may now stop during a
turn and collect data themselves, through `api/_lib/agent-tools.js`. Two rules hold, and both are enforced in code:

- **Only official sources satisfy the evidence gate.** `get_financial_statement` (NSE-filed XBRL),
  `get_price_and_technicals` (NSE end-of-day) and `get_fund_nav` (AMFI) write research sources exactly as the nightly
  adapters do. `get_announcements`, `fetch_official_page` and `search_web` return context only — `agent-search.js` never
  touches the research-sources table, so a search result cannot reach the gate at all.
- **Fetched text is data, never instruction.** Everything a page or a search returns is wrapped in an
  `UNTRUSTED SOURCE DATA` frame that says so, with markup stripped and length capped. The gate that decides
  BUY/HOLD/SELL is computed in code from verified sources and never reads model output.

The loop is bounded at two collection rounds per turn and three tools per round, then a final call with no tools so JSON
mode applies again. A model that returns no tool calls — including one that cannot do tools — takes exactly the path it
took before, so offering tools cannot break a run.

> **Unverified:** `docs.tavily.com` is unreachable from the development network, so Tavily's request and response field
> names could not be read from its documentation. Both known auth styles are sent and the response is parsed tolerantly,
> as the TejHQ adapter already does for an undocumented provider. The first real call records the true shape under
> provider `Web search` on the API usage page; correct the field list from that evidence, not from guesswork.

### Fincrux setup

Set `FINCRUX_API_KEY` (and optionally `FINCRUX_API_KEY_2` through `FINCRUX_API_KEY_10`) as environment defaults only in the Development Preview environment. Never commit a key or include it in stored source URLs or logs. Additional keys can be added and ordered from Stock Advisor → Provider Health; database keys are encrypted with AES-256-GCM using a key derived from `WEALTH_SESSION_SECRET`, and are tried before environment defaults. The UI shows only masked values. Disable or remove a database override to stop using it; environment defaults remain untouched.

The collector reserves each actual key attempt in the existing `wealth_stock_advisor_research_sources` table under a Postgres advisory lock scoped to that account key. Fincrux documents API keys as account-linked and the Hobby plan as five requests per day. Each configured account key therefore has its own five-request IST-day allowance; two separate accounts with one key each provide ten requests in total. Failed attempts count against the account that made them. If one account is exhausted, the collector can continue with another account. No separate quota table is created.

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
