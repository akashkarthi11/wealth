Run the user's consolidated HOURLY Wealth operations (API version: TSD Claude Plan 3, migrations 0000–0008).

PRODUCTION ONLY · WRITES THROUGH THE API ONLY
- Base URL: $WEALTH_API_BASE (the Production site, e.g. https://wealth-karthi-4a8f.vercel.app). Every write is an HTTPS call with the header
  Authorization: Bearer $WEALTH_INGEST_SECRET. Never print the secret.
- Never write SQL. The app validates prices (live sources only, newest only, USD needs FX), de-duplicates Gmail imports, keeps the
  legacy dashboard tables in step and audits every write (actor 'agent').
  Read-only SQL on the Neon PRODUCTION project (blue-lake-22403547, database neondb) is allowed for reading holdings (below).
  Never use Development (cold-smoke-05088150 or any other non-production database).
- Every write endpoint accepts ?dryRun=1. Never place or change trades; never change quantities, accounts or balances; never delete.
- Times: send ISO timestamps with time zone; report in Asia/Kolkata.

0) PREFLIGHT (stop and report if it fails)
- GET $WEALTH_API_BASE/api/health → database.reachable is true and database.latestMigration is 0008_plan3_data_quality_interest_obligations_audit or later.
- GET $WEALTH_API_BASE/api/email-imports/seen?ids=preflight with the Bearer token → must be 200 ({"seen":[]}). 404 = the Plan 3 code is not
  deployed yet; 401 = WEALTH_INGEST_SECRET is missing or wrong. In either case stop and report (the database alone is not enough).

HOLDINGS — read-only SQL, one source for every section
  SELECT a.id AS account_id, a.bank_name AS institution, s.code AS subtype, i.id AS instrument_id, i.asset_class, i.symbol, i.name,
         trim(i.currency) AS currency, i.unit, i.price_source_symbol, i.price_hold_reason, h.quantity, h.invested_value,
         p.price AS last_price, p.as_of AS last_price_as_of, p.source AS last_source, p.fx_to_inr
  FROM wealth_holdings h
  JOIN wealth_accounts a ON a.id = h.account_id AND a.user_id = (SELECT id FROM wealth_users WHERE role='admin' LIMIT 1) AND a.status = 'active'
  JOIN wealth_account_subtypes s ON s.code = a.subtype_code
  JOIN wealth_instruments i ON i.id = h.instrument_id
  LEFT JOIN wealth_v_latest_prices p ON p.instrument_id = i.id
  WHERE h.status = 'active';
Subtypes: demat_equity (Angel One stocks/ETFs), mutual_fund, us_brokerage (INDmoney, USD), digital_gold, digital_silver.

1) INDIAN EQUITY STOCK ADVISOR (analysis only)
- Inputs: the demat_equity holdings above, the latest advisor reports, and current market information.
- Use the latest Indian market prices, disclosures, results, guidance, news, sector/index trends, valuation, earnings quality, growth,
  balance-sheet strength and risk/reward. Timestamp sources; distinguish live from delayed data.
- Disciplined BUY / HOLD / SELL. Check diversification, sector concentration, position sizing, small-cap exposure, overall risk,
  Angel One MTF exposure and borrowing costs where data exists (MTF data is not stored — say so). No F&O, no non-Indian markets, no orders.

2) MARKET PRICES — one call, the app writes the account model and the legacy table
- For each instrument held, fetch the latest reliable quote; state session, date/time and currency.
- India 24K gold and 999 silver: the price is the India benchmark in INR per GRAM (IBJA 999). Provider rates (Paytm buy/sell) go in the
  report only. The daily app refresh does NOT write metal futures parity, so this hourly benchmark is the metal price source.
- USD instruments need the USD→INR rate (fxToInr) with the same quote time.
- Send all quotes in one batch (max 200):
  POST /api/prices {"items":[{"assetClass":"indian_equity","symbol":"LT","price":4210.5,"currency":"INR","asOf":"2026-11-11T09:45:00+05:30","source":"NSE"},
                             {"assetClass":"us_equity","symbol":"NVDA","price":181.2,"currency":"USD","asOf":"…","source":"Yahoo Finance","fxToInr":88.6}, …]}
  symbol = the instrument symbol from the holdings query (or its price_source_symbol).
  source must be exactly one of: 'NSE', 'BSE', 'StockAnalysis.com real-time quote', 'ChartExchange real-time quote', 'Yahoo Finance',
  'MFAPI.in', 'AMFI NAV', 'IBJA AM benchmark 999', 'IBJA PM benchmark 999'.
- Per-item results: stored · already_stored · older_than_latest (a newer price exists — fine) · on_hold (the instrument's price_hold_reason,
  e.g. Nippon India Large Cap Fund while its units are reviewed — report the NAV instead) · rejected (reason given; fix or report).
- Values and day-over-day changes: quantity × price (× USD→INR), only when both are verified. Report stale or missing prices. Never claim a broker sync.

3) GMAIL TRANSACTION SYNC — the app is the dedupe source of truth
- List candidate Gmail message IDs (handle pagination). Ask which are already processed, in batches of up to 500:
  GET /api/email-imports/seen?ids=<id1>,<id2>,…  → {"seen":[…]}
  SKIP every seen id entirely — do not fetch its body or attachments. Never retry needs_review automatically.
- For each NEW message, fetch the body/attachments only when relevant (bank/card alerts, statements, refunds, salary, interest credits,
  investment movements). Ignore promotions, OTPs, balance-only alerts, failed/reversed transactions without opening attachments.
- Record exactly one outcome per new message, after deciding:
  • real movement(s):  POST /api/email-imports {"messageId":"<id>","outcome":"import","transactions":[{"kind":"expense","category":"Food",
      "description":"…","amount":250,"accountId":"<own savings/current/credit-card account uuid>","occurredOn":"YYYY-MM-DD"}]}
      (several movements in one email → several items; the app numbers their references gmail:<id>:<n>)
  • source account not certain, or anything ambiguous: {"messageId":"<id>","outcome":"needs_review"}
  • not a transaction: {"messageId":"<id>","outcome":"ignored"}
  The app refuses non-bank/card accounts (400), returns already_recorded for a seen message, and reports matched_existing when the same
  movement was imported before (same account, date, amount, kind). Own-account transfers: one transaction, kind 'transfer'.
- Account ids: SELECT id, bank_name, account_name, masked_identifier, subtype_code FROM wealth_accounts WHERE status='active'
  AND subtype_code IN ('savings','current','credit_card') AND user_id=(SELECT id FROM wealth_users WHERE role='admin' LIMIT 1);  (read-only)
- Counts to report: candidates, already-seen skipped without body fetch, newly reviewed, imported, matched_existing, needs_review, ignored, errors.

4) STOCK ADVISOR REPORT — REQUIRED, one per completed run
  POST /api/stock-advisor {"run_at":"<ISO time of this run>","report_text":"<human-readable review>","report_json":{…}}
- report_json keys: summary; recommendations (array of {symbol, company, action: BUY|HOLD|SELL, reason, entry_condition});
  portfolio_review ({diversification, mtf}); market_snapshot ({as_of, source_status, nifty, sensex} — null where not verified);
  holdings_covered (demat_equity symbols); limitations. Save an empty recommendations array when no call is justified and say why.
- 201 = saved (report its run_at); 200 alreadySaved = this run_at exists. Any other status: report the exact error; do not claim it was saved.

5) HOURLY REPORT (concise)
Market snapshot; advisor calls and reasons; diversification / MTF / borrowing-cost notes; prices per result status (with sources and quote
times) and anything on_hold / rejected / stale; Gmail counts (including already-seen skipped without fetching the body); imported transactions
and items needing review; whether the advisor report was saved and its run_at.
