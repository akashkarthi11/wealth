Run the user's consolidated HOURLY Wealth operations (schema version: migrations 0000–0005, account model v2).

PRODUCTION-ONLY DATABASE POLICY
- Every read and write uses the Neon PRODUCTION project blue-lake-22403547, database neondb, primary connection. Production is the single source of truth. Never read from, write to, compare against or sync to Development (project cold-smoke-05088150 or any other non-production database). If production is unavailable, stop the affected operation, report the exact failure, and do not fall back.
- Writes allowed in this task, and nothing else:
  • prices: wealth_instrument_prices (account model), wealth_market_prices and wealth_price_history (legacy, kept in step until the dashboard switch);
  • Gmail: wealth_email_imports, and wealth_transactions for confirmed imports only;
  • advisor: wealth_stock_advisor_reports.
- Never modify holdings, quantities, positions, accounts or balances, never place or change trades, never create or alter schema.
- NEVER delete data: no DELETE, TRUNCATE or DROP. Prices are added as new rows; history is never removed.

0) PREFLIGHT (stop if any check fails, and report it)
- SELECT id FROM wealth_schema_migrations ORDER BY id → must include 0005_link_obligations_and_interest; otherwise stop.
- Resolve user_id from the admin row in wealth_users (role='admin'); never hard-code it.
- Times: store timestamps with time zone; report in Asia/Kolkata.

HOLDINGS — read them from the account model (one source for every section)
  SELECT a.id AS account_id, a.bank_name AS institution, s.code AS subtype, i.id AS instrument_id, i.asset_class, i.symbol, i.name,
         trim(i.currency) AS currency, i.unit, i.price_source_symbol, h.quantity, h.invested_value,
         p.price AS last_price, p.as_of AS last_price_as_of, p.source AS last_source, p.fx_to_inr
  FROM wealth_holdings h
  JOIN wealth_accounts a ON a.id = h.account_id AND a.user_id = $admin AND a.status = 'active'
  JOIN wealth_account_subtypes s ON s.code = a.subtype_code
  JOIN wealth_instruments i ON i.id = h.instrument_id
  LEFT JOIN wealth_v_latest_prices p ON p.instrument_id = i.id
  WHERE h.quantity > 0;
Subtypes: demat_equity (Angel One stocks/ETFs), mutual_fund, us_brokerage (INDmoney, USD), digital_gold, digital_silver. Never invent or change a quantity.

1) INDIAN EQUITY STOCK ADVISOR (analysis only)
- Inputs: the demat_equity holdings above (symbol, quantity, invested value, last price), the latest reports in wealth_stock_advisor_reports (prior decisions, rules, entry prices, position sizes), and current market information.
- Use the latest Indian market prices, company disclosures, results, guidance, relevant news, sector/index trends, valuation, earnings quality, growth, balance-sheet strength and risk/reward. Timestamp sources; distinguish live from delayed data.
- Apply disciplined BUY / HOLD / SELL logic. Check diversification, sector concentration, position sizing, small-cap exposure, overall portfolio risk, Angel One MTF exposure and borrowing costs where data exists (MTF data is not stored in the database — say so if unavailable). Prioritise quality Indian growth stocks and approved core holdings. No F&O, no non-Indian markets, no orders, no portfolio changes. Do not force trades.

2) MARKET PRICES — write to the account model AND the legacy table
- For each instrument held: fetch the latest reliable quote; state session, date/time and currency.
- India 24K gold and 999 silver: the instrument price is the India benchmark in INR per GRAM (IBJA 999). Report provider rates (Paytm buy/sell/redemption) separately in the report only — do NOT store them as the instrument price (one valuation source per instrument).
- USD instruments need the USD→INR rate with its timestamp. Without a rate, do not store the USD price.
- Source names — use one of these EXACT strings so the app treats the price as live (any other name is shown as a manual price):
  'NSE', 'BSE', 'StockAnalysis.com real-time quote', 'ChartExchange real-time quote', 'Yahoo Finance', 'MFAPI.in', 'AMFI NAV', 'IBJA AM benchmark 999', 'IBJA PM benchmark 999'.
- Only store a price whose quote time is NEWER than last_price_as_of; never store zero, negative or unverified prices.

 2a) Account model (always):
  INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr)
  VALUES (<instrument_id>, <quote time>, <source>, <price per share/unit/gram in instrument currency>, <USD→INR for USD instruments, else NULL>)
  ON CONFLICT (instrument_id, as_of, source) DO NOTHING;

 2b) Legacy table (until the dashboard is switched to the account model — the live dashboard reads this):
  find the legacy asset: SELECT a.id, a.user_id FROM wealth_investment_assets a JOIN wealth_positions p ON p.id = a.position_id
    WHERE p.user_id = $admin AND p.record_type NOT LIKE '%\_ARCHIVED' AND a.asset_class = <asset_class> AND (a.symbol = <symbol> OR p.ticker = <symbol> OR p.name = <name>);
  upsert the latest price:
  INSERT INTO wealth_market_prices (asset_id, user_id, unit_price, currency, source, source_timestamp, fetched_at, status, metadata)
  VALUES (<asset id>, $admin, <price>, <currency>, <source>, <quote time>, now(), 'fresh',
          jsonb_build_object('fx_to_inr', <rate or null>, 'fx_as_of', <rate time or null>, 'provider_symbol', <symbol>))
  ON CONFLICT (asset_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, currency = EXCLUDED.currency, source = EXCLUDED.source,
    source_timestamp = EXCLUDED.source_timestamp, fetched_at = now(), status = 'fresh', metadata = EXCLUDED.metadata
  WHERE wealth_market_prices.source_timestamp IS NULL OR EXCLUDED.source_timestamp > wealth_market_prices.source_timestamp;
  and append history once: INSERT INTO wealth_price_history (asset_id, user_id, unit_price, currency, source, source_timestamp, metadata)
    SELECT <asset id>, $admin, <price>, <currency>, <source>, <quote time>, '{}'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM wealth_price_history WHERE asset_id = <asset id> AND source = <source> AND source_timestamp = <quote time>);
  USD rows MUST carry fx_to_inr and fx_as_of in metadata, or the legacy dashboard cannot convert them.

- HOLD — Nippon India Large Cap Fund: its stored units (29.02) are under review (value implies ≈ 69.7 units). Do not store its NAV in either table until the owner confirms the unit count; report the current NAV instead.
- Values and day-over-day changes: quantity × price (× USD→INR), only when both are verified. Report stale or missing prices explicitly. Never claim a live broker sync.

3) GMAIL TRANSACTION SYNC — TABLE-FIRST, SKIP ALREADY READ
- List candidate Gmail message IDs (handle pagination). For each, check wealth_email_imports (user_id = $admin, provider = 'gmail', message_id). If a row exists, SKIP the message entirely — do not fetch its body, open or download attachments, or parse it. Never retry needs_review automatically.
- For new message IDs only, fetch body/attachments when relevant to bank/card transaction alerts, statements, refunds, salary or interest credits, or investment movement notices. Ignore promotions, OTPs, balance-only alerts, failed/reversed transactions and irrelevant mail without opening attachments.
- For a confirmed real movement, in ONE database transaction:
  a) INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref)
     VALUES ($admin, <income|expense|transfer|investment|liability>, <category>, <description>, <amount > 0>, '', <account id>, <date>, 'gmail:' || <message_id> [|| ':' || <n> when one email has several movements>])
     ON CONFLICT DO NOTHING RETURNING id;
     account_id must be the user's own bank or card account (subtype savings, current or credit_card); if the source account is not certain, do not insert — mark needs_review.
     If nothing is returned, the reference already exists → treat as matched_existing (look up its id by external_ref).
     Also check for the same movement imported earlier without a reference (same account, date, amount, kind) → matched_existing.
  b) INSERT INTO wealth_email_imports (user_id, provider, message_id, transaction_id, import_status)
     VALUES ($admin, 'gmail', <message_id>, <transaction id or NULL>, <imported|matched_existing|needs_review|ignored>)
     ON CONFLICT (user_id, provider, message_id) DO NOTHING;
- Every reviewed new message gets exactly one wealth_email_imports row, even when it contains no transaction (ignored). Record a message only after its outcome is safely written. A message with several attachments is recorded once.
- Distinguish own-account transfers (record once, kind 'transfer') to avoid double counting. Never change balances from email; never use market prices to create transactions.
- A sync cursor may speed up discovery but is never the dedupe source of truth — the message-ID lookup is.
- Counts to report: candidates, already-seen skipped without body fetch, newly reviewed, imported, matched_existing, needs_review, ignored, persistence errors.

4) STOCK ADVISOR REPORT — REQUIRED, one row per completed run
  INSERT INTO wealth_stock_advisor_reports (user_id, run_at, report_text, report_json)
  VALUES ($admin, now(), <human-readable review and rationale>, <jsonb>)
  ON CONFLICT DO NOTHING RETURNING id, run_at;
- report_json keys: summary (string); recommendations (array of {symbol, company, action: BUY|HOLD|SELL, reason, entry_condition}); portfolio_review ({diversification, mtf}); market_snapshot ({as_of, source_status, nifty, sensex} — null where not verified); holdings_covered (array of symbols from the demat_equity holdings); limitations (string). Save an empty recommendations array when no call is justified and explain why in summary.
- (user_id, run_at) is unique: one row per run. Verify by selecting the newest row for the admin user; report its run_at. If the write fails, report the exact error and do not claim it was saved.

5) HOURLY REPORT (concise)
Market snapshot; advisor calls and reasons; diversification / MTF / borrowing-cost notes; prices stored (count per table, with sources and quote times) and any HOLD/stale/missing; Gmail counts (including already-seen skipped without fetching the body); imported transactions and items needing review; whether the advisor report was saved and its run_at. Keep everything idempotent and source-backed.
