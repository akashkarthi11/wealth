Run the user's DAILY Wealth operations (API version: TSD Claude Plan 3, migrations 0000–0008).

PRODUCTION ONLY · WRITES THROUGH THE API ONLY
- Base URL: $WEALTH_API_BASE (the Production site, e.g. https://wealth-karthi-4a8f.vercel.app). Every write is an HTTPS call with the header
  Authorization: Bearer $WEALTH_INGEST_SECRET. Never print the secret.
- Never write SQL. The app validates, de-duplicates, applies the arithmetic and records an audit trail (actor 'agent').
  Read-only SQL on the Neon PRODUCTION project (blue-lake-22403547, database neondb) is allowed only for the spending report in step 5.
  Never use Development (cold-smoke-05088150 or any other non-production database).
- Every write endpoint accepts ?dryRun=1 (validates and reports, writes nothing). Use it whenever unsure.
- Nothing is ever deleted. Corrections are new rows or new periods; the API refuses anything else.
- Dates and times: Asia/Kolkata. "Yesterday" = the last completed IST day.

0) PREFLIGHT (stop and report if it fails)
- GET $WEALTH_API_BASE/api/health → database.reachable is true and database.latestMigration is 0008_plan3_data_quality_interest_obligations_audit or later.
  If not, stop: this prompt needs Plan 3.

1) INTEREST SOURCES (read)
- GET /api/interest → sources[] lists every linked account with its product, current rate (decimal), rate start date, last accrual date,
  accrued this month, accrued since start and credited total. unlinked[] lists interest-bearing accounts without a product.
- Keep every source separate: Slice Savings, Atom Savings, Slice FD and Angel One FD are different products and accounts.
- unlinked accounts (e.g. Bank of India, HDFC, Roarbank): report "needs product/rate link". Do not invent a product.

2) RATES
- Retrieve: the official RBI repo rate (context only, never a product rate) and the official Slice Savings / Slice Atom terms.
  Note the source URL, checked time, effective date and product-specific differences.
- For each product whose verified rate you confirmed, submit it:
  POST /api/interest/rates {"productKey":"slice-savings","annualRate":0.055,"effectiveFrom":"YYYY-MM-DD","sourceUrl":"https://…","evidence":"<what the page says>"}
  • 200 {"result":"unchanged"} — same as the current rate; nothing written (the normal case).
  • 201 {"result":"recorded"} — new period stored; the previous open period was given an end date by the app.
  • 409 — effectiveFrom is not after the current period's start: report it for the owner; do not retry with another date.
- Rates are decimal fractions (5.5% = 0.055). Evidence already on record (do not resubmit unless it changes):
  Slice FD 7.75% (user-provided screenshot, 10 Nov 2026); Angel One FD 8.00% (user-confirmed, 10 Nov 2026).

3) DAILY ACCRUAL (the app calculates; you trigger and report)
- The app accrues automatically every night at 01:30 IST. Run it again as a catch-up (idempotent — a second run writes nothing):
  POST /api/interest/run
  Response: through (date), accounts[] with accountKey, status, rowsWritten, corrections, interestTotal, skipped[].
- Status meanings:
  • calculated — rows written for the days listed; corrections > 0 means a past estimate changed (a correction revision was appended).
  • up_to_date — nothing to add.
  • stale_balance — no verified balance within 2 days of the day; ask the owner for a current balance screenshot.
  • no_rate — no rate period covers the day; check step 2.
  • pending_terms — FD without principal / booking date / payout; ask the owner for the FD terms (they are recorded in the app).
  • needs_link — interest-bearing account with no product.
- The formula (principal × rate ÷ 365/366, 8 decimals, verified balance ≤ 2 days old) is implemented and tested in the app; do not recalculate it yourself.
  Bank-confirmed days are never overwritten.

4) ACTUAL INTEREST CREDITED (only with bank evidence the owner provided)
- POST /api/interest/credits {"accountId":"<uuid from GET /api/interest>","amount":7.21,"creditedOn":"YYYY-MM-DD","reference":"<bank reference>",
  "newBalance":<verified balance after the credit, optional>,"balanceAsOf":"<ISO time>","evidence":"<screenshot/statement>"}
  Without a bank reference the app uses interest:<account_key>:<date>:<amount>. 409 = already recorded (do not retry).
- Never infer a credit from an accrual.

5) SPENDING (verification only — read-only SQL)
- Totals are computed live by the app; transactions marked as duplicates are excluded. For the IST calendar report yesterday, week to date,
  month to date and year to date expense totals and counts:
  SELECT sum(amount), count(*) FROM wealth_transactions WHERE user_id=(SELECT id FROM wealth_users WHERE role='admin' LIMIT 1)
    AND kind='expense' AND duplicate_of IS NULL AND occurred_on BETWEEN <from> AND <to>;

6) REPORT (never claim success unless the API response confirms it)
- RBI repo rate (context); each product's rate, effective date and source URL, and the /api/interest/rates result for each.
- For EACH source separately: account, product, rate, last accrual date, rows written today, interest total, status and the reason for any skipped day.
- Slice FD and Angel One FD explicitly, even when pending_terms.
- Accounts needing a product link; corrections written; actual credits recorded (with reference); spending totals.
- Every missing or stale input. Distinguish estimated accrual from credited interest.
