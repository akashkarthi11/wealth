# Scheduled task prompts — Wealth Ledger

Prompts for the owner's scheduled assistant tasks (ChatGPT). **Read [`rules.md`](rules.md) first; it always wins over this file.**
Keep this file on the `development` branch; the assistant reads it from there.

| Task | Schedule | Writes to the database |
|---|---|---|
| **Daily Wealth check** (below) | once a day, after 02:00 IST | only a changed interest rate (`wealth_interest_rates`) |
| **Hourly Wealth operations** (below) | hourly | prices (`wealth_instrument_prices`, `wealth_market_prices`), Gmail imports (`wealth_email_imports`, `wealth_transactions`), Stock Advisor report |

Version: 2026-11-11 · replaces the old "DAILY Wealth operations (migrations 0000–0005)" prompt.

## What changed from the old daily prompt (and why)
1. **No interest calculation by the assistant any more.** The app's own nightly job (Vercel cron `/api/nightly`, 01:30 IST) calculates interest for every linked account, writes the interest ledger, keeps one "interest this month" income row per daily-credited account, and shares Atom interest across the Atom splits. The assistant writing ledger rows, "daily interest credit" rows or interest income doubled the interest (11 Nov 2026 incident). See `rules.md` §2a.
2. **No balance writes** in the daily task. Balances change only when the owner shares a screenshot and asks — then as `verified`, through the account, never `pending_reconciliation`, never back-dated as an estimate (the database refuses those from external writers).
3. **Schema is current**: 20 migrations (through `0019_account_splits`), not 0000–0005.
4. **FD terms are recorded** (both booked 5 Nov 2026, cumulative, quarterly; values Slice ₹3,005.04, Angel One ₹1,001.30 on 11 Nov) — the app accrues them.
5. **Spending totals must exclude rows marked as duplicates** (`duplicate_of IS NULL`).
6. **New daily data checks**: rows with no account, payments to people stored as spending, interest rows from screenshots, duplicate UPI references, balance mismatches, Atom splits.

---

## Daily Wealth check — prompt (copy everything inside the box)

```text
Run the user's DAILY Wealth check (account model v2; schema through migration 0019).

READ FIRST
- Read rules.md on the development branch of akashkarthi11/wealth before anything else and follow it. If this prompt and
  rules.md disagree, rules.md wins.

DATABASE POLICY
- Use only the Neon PRODUCTION database (project blue-lake-22403547, database neondb). Never read from, write to or
  compare against Development. If Production is unavailable, stop that step and report the exact error.
- This task is a CHECK-AND-REPORT task. The ONLY write allowed is a new interest-rate period when an official rate has
  changed (step 2). Everything else is read-only.
- NEVER write interest of any kind: no wealth_interest_ledger rows, no "daily interest credit" rows, no interest income
  transactions, no interest statements. The app's nightly job does all interest (rules.md §2a).
- NEVER change balances (wealth_accounts balance columns, wealth_account_balances) or Atom splits in this task.
- NEVER delete data (no DELETE, TRUNCATE, DROP) and never change the schema.
- Start every write transaction with: SELECT set_config('wealth.actor', 'agent', true);

0) PREFLIGHT (stop and report if a check fails)
- SELECT id FROM wealth_schema_migrations ORDER BY id → must include 0019_account_splits.
- user_id = the admin row in wealth_users (role = 'admin'); never hard-code it.
- Dates in Asia/Kolkata. "Yesterday" = the last completed IST day.

1) INTEREST SOURCES (read only)
- Linked sources: SELECT a.account_key, a.bank_name, a.account_name, a.subtype_code, p.product_key, p.provider, p.credit_frequency
  FROM wealth_interest_links l JOIN wealth_accounts a ON a.id = l.account_id JOIN wealth_interest_products p ON p.id = l.product_id
  WHERE a.user_id = $admin AND a.status = 'active';
- Active savings / FD accounts without a link → report as "no interest product/rate linked" (e.g. Bank of India, HDFC,
  Roarbank savings). Do not create products or links.

2) RATES (the only write)
- Look up the official current rates: Slice Savings and Slice Atom (Slice Small Finance Bank terms page), and the RBI repo
  rate (context only — never use it as a product rate). Record source URL and checked time.
- Current open rate per product: wealth_interest_rates with that product_key, effective_to IS NULL, latest effective_from.
- ONLY if the verified official rate differs from the open rate:
  INSERT INTO wealth_interest_rates (provider, product_key, annual_rate, effective_from, source_url, source_checked_at, notes)
  VALUES (<product's provider exactly>, <product_key>, <decimal, 5.5% = 0.055>, <effective date>, <url>, now(), <evidence>)
  ON CONFLICT DO NOTHING;
  then close the previous open period: UPDATE wealth_interest_rates SET effective_to = <new effective_from − 1 day>,
  notes = notes || ' [closed <date>: superseded by <rate>]' WHERE id = <that row>.
- FD rates are fixed at booking (Slice FD 7.75%, Angel One FD 8.00%) — never change them from a web page.
- If the rate is unchanged, write nothing.

3) NIGHTLY INTEREST JOB (read only — report, never fill gaps yourself)
- Last run: SELECT job, status, started_at, summary FROM wealth_job_runs WHERE job = 'interest-accrual' ORDER BY started_at DESC LIMIT 1;
  Report "missed" if it did not run since 01:30 IST today, or "failed" with the error from summary.
- Yesterday's accruals per source: SELECT product_key, accrual_date, sum(interest_amount) FROM wealth_interest_ledger
  WHERE user_id = $admin AND accrual_date = <yesterday> GROUP BY 1, 2;
- Interest this month (Activity): SELECT account, amount, occurred_on FROM wealth_transactions
  WHERE user_id = $admin AND external_ref LIKE 'interest-month:%' AND to_char(occurred_on,'YYYY-MM') = <this month>;
- If something is missing or zero, REPORT it. Do not insert interest to "fix" it.

4) BALANCES AND ATOM SPLITS (read only)
- For each active savings / credit-card account: newest wealth_account_balances row (balance, as_of, status) and
  wealth_accounts.current_balance / balance_as_of. Flag any account where the two disagree, or whose newest verified balance
  is older than 3 days (ask the owner for a fresh screenshot).
- Atom splits: SELECT s.name, b.balance, b.as_of, b.status FROM wealth_account_splits s LEFT JOIN LATERAL
  (SELECT balance, as_of, status FROM wealth_account_split_balances WHERE split_id = s.id ORDER BY as_of DESC LIMIT 1) b ON true
  WHERE s.status = 'active'; plus moves after that balance from wealth_account_split_moves. Report each split and whether the
  splits add up to the Atom balance (within ₹2). The app adds each split's share of interest itself.

5) SPENDING (read only)
- Expense totals and counts for yesterday, week to date (Mon–), month to date and year to date (IST):
  SELECT sum(amount), count(*) FROM wealth_transactions WHERE user_id = $admin AND kind = 'expense'
    AND duplicate_of IS NULL AND occurred_on BETWEEN <from> AND <to>;
- Do not invent totals; if a query fails, report it.

6) DATA CHECKS (read only — report, the owner decides)
- Transactions from the last 7 days with account_id IS NULL ("needs account").
- Payments to people stored as spending: kind = 'expense' AND category ILIKE '%money transfer%' (should be kind 'transfer').
- Interest rows that did not come from the nightly job: kind = 'income' AND (category ILIKE '%interest%' OR description ILIKE
  '%interest%') AND (external_ref IS NULL OR external_ref NOT LIKE 'interest-month:%') AND description NOT LIKE '%HDFC statement%'
  AND duplicate_of IS NULL AND occurred_on >= '2026-11-01'  → should be none.
- Same date + account + amount + description twice (possible duplicate), and transactions without an external_ref (UPI reference).

7) REPORT (only what you verified in Production)
- RBI repo rate (context); each product's open rate with effective date and source; any rate period written.
- Nightly job: last run time and status; yesterday's accrual per source; interest this month per account.
- Balances: per account newest balance, date, status; mismatches; stale balances needing a screenshot.
- Atom splits and their total vs the Atom balance.
- Spending: yesterday / week / month / year totals and counts.
- Data checks with the exact rows found.
- Every missing or stale input. Say clearly that interest figures come from the app's nightly job, not from this task.
```

---

## Hourly Wealth operations — what changed from the old prompt (and why)
1. **Schema check is 0019** and `rules.md` is read first (old prompt: 0000–0005).
2. **No more `wealth_price_history` writes.** The app stopped using it; `wealth_instrument_prices` is the price history. Writing it only adds unused rows.
3. **Gmail: interest is never imported** (`rules.md` §2a) — interest-credit emails are marked `ignored`; the nightly job records interest.
4. **Gmail: a payment to a person is a `transfer`, not spending**; cumulative / month-to-date totals in emails are never transactions; the UPI / bank reference is always kept.
5. **Rewards:** cashback credited as money is income on its card/account; reward-point and cashback summary emails are reported, not written.
6. Every write starts with `SELECT set_config('wealth.actor', 'agent', true);` so the audit log shows the writer.

## Hourly Wealth operations — prompt (copy everything inside the box)

```text
Run the user's HOURLY Wealth operations (account model v2; schema through migration 0019).

READ FIRST
- Read rules.md on the development branch of akashkarthi11/wealth before anything else and follow it. If this prompt and
  rules.md disagree, rules.md wins.

DATABASE POLICY
- Use only the Neon PRODUCTION database (project blue-lake-22403547, database neondb). Never read from, write to or compare
  against Development. If Production is unavailable, stop that step, report the exact error, and do not fall back.
- Writes allowed in this task, and nothing else:
  • prices: wealth_instrument_prices (price history) and wealth_market_prices (latest price, still read by some pages);
  • Gmail: wealth_email_imports, and wealth_transactions for confirmed imports only;
  • advisor: wealth_stock_advisor_reports.
- Do NOT write wealth_price_history (no longer used). Never modify holdings, quantities, positions, accounts, balances,
  Atom splits or rewards; never place or change trades; never create or alter schema.
- NEVER write interest of any kind (rules.md §2a) — the app's nightly job records interest.
- NEVER delete data: no DELETE, TRUNCATE or DROP.
- Start every write transaction with: SELECT set_config('wealth.actor', 'agent', true);

0) PREFLIGHT (stop and report if a check fails)
- SELECT id FROM wealth_schema_migrations ORDER BY id → must include 0019_account_splits.
- user_id = the admin row in wealth_users (role = 'admin'); never hard-code it.
- Store timestamps with time zone; report in Asia/Kolkata.

HOLDINGS — read from the account model (one source for every section)
  SELECT a.id AS account_id, a.bank_name AS institution, s.code AS subtype, i.id AS instrument_id, i.asset_class, i.symbol, i.name,
         trim(i.currency) AS currency, i.unit, i.price_source_symbol, i.price_hold_reason, h.quantity, h.invested_value,
         p.price AS last_price, p.as_of AS last_price_as_of, p.source AS last_source, p.fx_to_inr
  FROM wealth_holdings h
  JOIN wealth_accounts a ON a.id = h.account_id AND a.user_id = $admin AND a.status = 'active'
  JOIN wealth_account_subtypes s ON s.code = a.subtype_code
  JOIN wealth_instruments i ON i.id = h.instrument_id
  LEFT JOIN wealth_v_latest_prices p ON p.instrument_id = i.id
  WHERE h.quantity > 0;
Subtypes: demat_equity (Angel One stocks/ETFs), mutual_fund, us_brokerage (INDmoney, USD), digital_gold, digital_silver.
Never invent or change a quantity.

1) INDIAN EQUITY STOCK ADVISOR (analysis only)
- Inputs: the demat_equity holdings above, the latest rows in wealth_stock_advisor_reports (prior decisions, entry prices,
  position sizes) and current market information.
- Use the latest Indian market prices, company disclosures, results, guidance, relevant news, sector/index trends, valuation,
  earnings quality, growth, balance-sheet strength and risk/reward. Timestamp sources; distinguish live from delayed data.
- Apply disciplined BUY / HOLD / SELL logic. Check diversification, sector concentration, position sizing, small-cap exposure,
  overall portfolio risk, Angel One MTF exposure and borrowing cost (MTF data is not stored — say so if unavailable).
  Prioritise quality Indian growth stocks and approved core holdings. No F&O, no non-Indian markets, no orders, no portfolio
  changes. Do not force trades.

2) MARKET PRICES
- For each instrument held: fetch the latest reliable quote; state session, date/time and currency.
- Skip any instrument with a price_hold_reason (e.g. Nippon India Large Cap Fund — units under review): report its current
  NAV only, store nothing.
- India 24K gold and 999 silver: the instrument price is the India benchmark in INR per GRAM (IBJA 999). Report provider rates
  (Paytm buy/sell) in the report only — never store them as the instrument price.
- USD instruments need the USD→INR rate with its timestamp; without a rate, do not store the USD price.
- Source names — use one of these EXACT strings: 'NSE', 'BSE', 'StockAnalysis.com real-time quote',
  'ChartExchange real-time quote', 'Yahoo Finance', 'MFAPI.in', 'AMFI NAV', 'IBJA AM benchmark 999', 'IBJA PM benchmark 999'.
- Only store a price whose quote time is NEWER than last_price_as_of; never store zero, negative or unverified prices.

 2a) Price history (always):
  INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr)
  VALUES (<instrument_id>, <quote time>, <source>, <price per share/unit/gram in instrument currency>, <USD→INR for USD, else NULL>)
  ON CONFLICT (instrument_id, as_of, source) DO NOTHING;

 2b) Latest price (still read by some pages):
  find the asset: SELECT a.id FROM wealth_investment_assets a JOIN wealth_positions p ON p.id = a.position_id
    WHERE p.user_id = $admin AND p.record_type NOT LIKE '%\_ARCHIVED' AND a.asset_class = <asset_class>
      AND (a.symbol = <symbol> OR p.ticker = <symbol> OR p.name = <name>);
  INSERT INTO wealth_market_prices (asset_id, user_id, unit_price, currency, source, source_timestamp, fetched_at, status, metadata)
  VALUES (<asset id>, $admin, <price>, <currency>, <source>, <quote time>, now(), 'fresh',
          jsonb_build_object('fx_to_inr', <rate or null>, 'fx_as_of', <rate time or null>, 'provider_symbol', <symbol>))
  ON CONFLICT (asset_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, currency = EXCLUDED.currency, source = EXCLUDED.source,
    source_timestamp = EXCLUDED.source_timestamp, fetched_at = now(), status = 'fresh', metadata = EXCLUDED.metadata
  WHERE wealth_market_prices.source_timestamp IS NULL OR EXCLUDED.source_timestamp > wealth_market_prices.source_timestamp;
  USD rows MUST carry fx_to_inr and fx_as_of in metadata.
- Values and day-over-day changes: quantity × price (× USD→INR), only when both are verified. Report stale or missing prices.
  Never claim a live broker sync.

3) GMAIL TRANSACTION SYNC — TABLE-FIRST, SKIP ALREADY READ
- List candidate Gmail message IDs (handle pagination). For each, check wealth_email_imports (user_id = $admin,
  provider = 'gmail', message_id). If a row exists, SKIP the message entirely — do not fetch its body or attachments.
  Never retry needs_review automatically.
- For new message IDs only, open mail that is a bank/card transaction alert, statement, refund, salary credit or investment
  movement notice. Ignore promotions, OTPs, balance-only alerts, failed/reversed transactions and irrelevant mail.
- NEVER import interest (interest-credit alerts, "interest earned" lines in statements): mark the message 'ignored'.
- NEVER import a running / month-to-date total (e.g. "Nov round-ups ₹159", "interest this month") as a transaction — only
  single postings.
- Classify correctly:
  • payment to a person (UPI "sent to <name>") → kind 'transfer' (category 'Transfer sent'), NOT expense;
    money from a person → kind 'transfer' ('Transfer received'), NOT income;
  • between the owner's own accounts → kind 'transfer' ('Self transfer'), recorded once;
  • shop / merchant payment → 'expense'; salary, refund, cashback credited as money → 'income';
  • broker / fund / gold purchase → 'investment'; card bill or loan repayment → 'liability'.
- For a confirmed real movement, in ONE database transaction:
  a) INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref)
     VALUES ($admin, <kind>, <category>, <merchant/person · UPI ref <ref>>, <amount > 0>, '', <account id>, <date>,
             'gmail:' || <message_id> [|| ':' || <n> when one email has several movements>])
     ON CONFLICT DO NOTHING RETURNING id;
     account_id must be the owner's own account (savings, current or credit_card) named in the mail; if it is not certain,
     do not insert — mark needs_review. Keep the UPI / bank reference in the description.
     If nothing is returned, the reference already exists → matched_existing (look up its id by external_ref).
     Also check for the same movement imported earlier without a reference (same account, date, amount, kind) → matched_existing.
  b) INSERT INTO wealth_email_imports (user_id, provider, message_id, transaction_id, import_status)
     VALUES ($admin, 'gmail', <message_id>, <transaction id or NULL>, <imported|matched_existing|needs_review|ignored>)
     ON CONFLICT (user_id, provider, message_id) DO NOTHING;
- Every reviewed new message gets exactly one wealth_email_imports row, even with no transaction (ignored). Record a message
  only after its outcome is safely written.
- Reward points / cashback summaries / Monies statements: do not write; list them in the report for the owner.
- Never change balances from email; never use market prices to create transactions.
- Counts to report: candidates, already-seen skipped without body fetch, newly reviewed, imported, matched_existing,
  needs_review, ignored (with how many were interest), persistence errors.

4) STOCK ADVISOR REPORT — one row per completed run
  INSERT INTO wealth_stock_advisor_reports (user_id, run_at, report_text, report_json)
  VALUES ($admin, now(), <human-readable review and rationale>, <jsonb>)
  ON CONFLICT DO NOTHING RETURNING id, run_at;
- report_json keys: summary; recommendations (array of {symbol, company, action: BUY|HOLD|SELL, reason, entry_condition});
  portfolio_review ({diversification, mtf}); market_snapshot ({as_of, source_status, nifty, sensex} — null where not
  verified); holdings_covered (symbols); limitations. Save an empty recommendations array when no call is justified.
- Verify by selecting the newest row for the admin user; report its run_at. If the write fails, report the exact error.

5) HOURLY REPORT (concise)
Market snapshot; advisor calls and reasons; diversification / MTF / borrowing-cost notes; prices stored (count per table,
sources, quote times) and any held / stale / missing; Gmail counts (incl. already-seen skipped and interest ignored);
imported transactions and items needing review; reward/cashback mails for the owner; whether the advisor report was saved
and its run_at. Keep everything idempotent and source-backed.
```
