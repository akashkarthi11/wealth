# Stock Advisor hybrid deep-research upgrade

## Goal
Turn the existing three-call pilot into an evidence-first, durable research workflow. The current pilot is a prototype: it receives a ticker and company name, does not retrieve live market data, does not browse, and cannot support a current BUY/SELL instruction. This design keeps that limitation explicit until real providers are configured.

## Target run graph
1. Collect evidence: Indian exchange/company filings, latest financial statements, market price/volume, technical indicators and dated news.
2. Fundamental analyst: growth, quality, margins, cash conversion, leverage, governance, capital allocation and valuation.
3. Technical analyst: trend, relative strength, volume, volatility, support/resistance and risk levels from timestamped OHLCV.
4. Independent Bull and Bear analysts produce structured cases without seeing each other's draft.
5. Bull rebuttal addresses the Bear's strongest points; Bear rebuttal challenges the Bull response.
6. Evidence validator checks every material numeric claim against a source, publication/retrieval time and units.
7. CIO adjudicates BUY / HOLD / SELL / NO ACTION. Missing or stale critical data forces HOLD / DATA REQUIRED.
8. Independent external review is attached as a separate opinion; it cannot overwrite the internal CIO decision.
9. Persist transcript, evidence, model/provider metadata, costs and a benchmarkable prediction.

## Hybrid boundary
- Internal agents run server-side through a provider adapter (Vercel AI Gateway initially).
- External ChatGPT review uses a signed, expiring report bridge. The bridge payload contains only the selected research pack and redacted portfolio context; it does not expose credentials or allow a callback to place orders.
- Provider credentials stay in server environment variables. Never call providers from browser code.
- Exa/web research and Indian market-data adapters must be explicitly configured. A model's parametric knowledge is not a substitute for retrieved evidence.

## Evidence contract
The file api/_lib/stock-advisor-evidence.js normalizes source metadata, validates absolute HTTP(S) URLs, applies freshness downgrades and computes an action gate. A source marked verified by a provider is still downgraded if its retrieval timestamp exceeds the configured freshness window.

Critical evidence before a decision:
- current market price / OHLCV;
- latest financial statements / filings;
- current technical indicator set.

No critical evidence means DATA REQUIRED, not a fabricated score or target.

## Persistence added in migration 0040
- wealth_stock_advisor_research_sources: URL, publisher, dates, excerpts, evidence and verification status.
- wealth_stock_advisor_agent_outputs: stage-by-stage structured outputs, provider/model and token/cost metadata.
- wealth_stock_advisor_run_jobs: durable stage queue with attempts and retry state.
- wealth_stock_advisor_predictions and wealth_stock_advisor_evaluations: dated calls and later benchmark-relative outcomes.

Existing runs, reports, messages and Bull/Bear case tables remain intact.

## Portfolio risk rules
- Indian listed equities only unless the user explicitly changes scope.
- Read-only portfolio access; no broker trading permissions and no automatic orders.
- CIO must report sector concentration, single-name concentration, small-cap exposure, cash availability and MTF exposure/interest drag before sizing.
- BUY requires evidence-backed valuation and an explicit invalidation/risk plan. Otherwise HOLD / DATA REQUIRED.
- Recommendations are not position instructions; the user remains the decision-maker.

## Rollout gates
1. Configure research and market-data provider credentials in Development only.
2. Implement provider adapters and wire evidence collection into the run controller.
3. Add multi-round debate, validator and CIO stage persistence with idempotent retries.
4. Add signed ChatGPT review bridge and verify expiry, signature, payload redaction and replay protection.
5. Add UI for source provenance, stage progress, full transcript and per-agent history.
6. Run tests and a Development Preview; validate schema and cost/rate limits.
7. Obtain user approval before Production migration, merge or deployment.

## Explicitly not enabled by this change
- No active 09:48 scheduler/worker.
- No live data provider until credentials and contracts are configured.
- No ChatGPT API call from this application.
- No automatic trading.
- No Production database migration or Production deployment.
