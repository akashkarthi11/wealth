Run the user's DAILY Wealth operations (schema version: migrations 0000–0005, account model v2).

PRODUCTION-ONLY DATABASE POLICY
- Every read and write uses the Neon PRODUCTION project blue-lake-22403547, database neondb, primary connection. Production is the single source of truth. Never read from, write to, compare against or sync to Development (project cold-smoke-05088150 or any other non-production database). If production is unavailable, stop the affected operation, report the exact failure, and do not fall back.
- Routine idempotent writes listed below are authorized. Write ONLY to: wealth_interest_rates, wealth_interest_ledger, and — for verified bank credits only — wealth_transactions, wealth_accounts (balance columns of the matching account), wealth_account_balances. Do not modify any other table or record.
- NEVER delete data: no DELETE, TRUNCATE, DROP or schema changes (no CREATE/ALTER). Corrections are new rows (revisions) or an end date on a rate period; every overwritten value is kept in notes.

0) PREFLIGHT (stop if any check fails, and report it)
- SELECT id FROM wealth_schema_migrations ORDER BY id → must include 0005_link_obligations_and_interest. If it is missing or older, stop: the schema below does not apply.
- Required objects exist: wealth_interest_products, wealth_interest_rates, wealth_interest_ledger, wealth_accounts, wealth_account_balances, view wealth_v_latest_balances, wealth_account_subtypes.
- Resolve user_id from the admin row in wealth_users (role='admin'); never hard-code it.
- Use Asia/Kolkata for every date. "Yesterday" = the last completed IST day. Accrue up to yesterday, never today.

1) INTEREST SOURCE REGISTRY (discover — do not rely on a fixed list)
The registry is the v2 account model. There is NO wealth_interest_sources table in production; do not create one.
- Interest-bearing accounts = active accounts with subtype 'savings' or 'fixed_deposit':
  SELECT a.id, a.account_key, a.bank_name, a.account_name, a.subtype_code FROM wealth_accounts a
  WHERE a.user_id=$admin AND a.status='active' AND a.subtype_code IN ('savings','fixed_deposit');
  (Accounts with status 'merged' are historical duplicates — list them as history, never calculate them.)
- Interest products = wealth_interest_products (product_key is the identity; use its provider text EXACTLY in every rate/ledger row — e.g. 'Slice Small Finance Bank', never 'Slice').
- Account ↔ product link, in this order:
  a) existing ledger rows: SELECT DISTINCT account_id, product_id FROM wealth_interest_ledger WHERE user_id=$admin;
  b) known mapping:
     slice-savings  ↔ account_key 'slice-savings-3731'                            (Slice Savings)
     atom-savings   ↔ account_key 'atom-savings'                                   (Slice Atom Savings)
     slice-fd       ↔ account_key 'slice-fixed_deposit-slice-fd'                   (Slice FD)
     angel-one-fd   ↔ account_key 'angel-one-fixed_deposit-angel-one-fd-aggregate-' (Angel One FD)
  c) any other interest-bearing account (e.g. Bank of India, HDFC, Roarbank savings, or a new FD) has NO product yet → report it as "needs product/rate link"; do not calculate and do not invent a product row.
- Keep every source separate: never merge Slice Savings with Atom, Slice FD with Angel One FD, or any FD into a generic FD.

2) RATES
- On every run retrieve: the official RBI repo rate (context only — never use it as a product rate), and the official Slice Savings / Slice Atom terms. Record source URL, checked timestamp, effective date and product-specific differences.
- Current open rate per product: the row in wealth_interest_rates with that product_key, effective_to IS NULL and the latest effective_from. (slice-savings currently has two open rows, both 5.5%, from 2026-10-07 and 2026-11-09 — use the latest; do not add a third.)
- Insert a new rate period ONLY when the verified rate differs from the current open rate:
  INSERT INTO wealth_interest_rates (provider, product_key, annual_rate, effective_from, source_url, source_checked_at, notes)
  VALUES (<product's provider>, <product_key>, <decimal, e.g. 0.055>, <effective date>, <url>, now(), <evidence>)
  ON CONFLICT DO NOTHING;
  then give the previous open period an end date: UPDATE wealth_interest_rates SET effective_to = <new effective_from − 1 day>, notes = notes || ' [closed <date>: superseded by <rate>]' WHERE <that row's id> — this is the only UPDATE allowed on rates. product_id is filled automatically by a trigger.
- Evidence already on record (do not duplicate): Slice FD 7.75% p.a. (user-provided Slice FD screenshot, 10 Nov 2026); Angel One FD 8.00% p.a. (user-confirmed 10 Nov 2026).
- Store rates as decimal fractions (5.5% = 0.055).

3) PRINCIPAL (balances)
- Principal for an account and accrual date D = its latest balance on or before the end of D (IST) from wealth_account_balances (wealth_v_latest_balances gives the newest overall):
  SELECT balance, as_of, status FROM wealth_account_balances WHERE account_id=$id AND as_of < (D + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' ORDER BY as_of DESC LIMIT 1;
- Savings: require status 'verified' and as_of no more than 2 days before D; otherwise report "principal unavailable/stale" for that date and do not calculate.
- FDs: the stored balance is the displayed CURRENT VALUE, not principal. Slice FD ₹3,004.41 (account slice-fixed_deposit-slice-fd; legacy position d28c7a72-5314-47d8-bb87-3550020547c3) and Angel One FD ₹1,001.09 current / ₹1,000.00 invested (account angel-one-fixed_deposit-angel-one-fd-aggregate-; legacy position 43bf77a2-817e-4b9c-bc26-6c3d91cdf9c9). Booking date, original principal, maturity and payout/compounding terms are NOT recorded → report both as "rate known, accrual pending principal/tenure verification". Do not treat the ₹0.87 or ₹3.41 difference as credited interest.
- Never copy a balance into another table; always read it through the account.

4) DAILY ACCRUAL LEDGER (automatic, no approval)
- For each linked savings source independently, for every date D from (its last accrual_date + 1) through yesterday (IST) — catching up any missed days — with a valid principal and rate for D:
  interest = principal × annual_rate ÷ (366 if D's year is a leap year else 365), rounded to 8 decimals.
  INSERT INTO wealth_interest_ledger (user_id, provider, product_key, account_key, partition_key, accrual_date, principal, annual_rate, day_count, interest_amount, entry_type, revision, source_rate_id, source_url, calculation_status, notes)
  VALUES ($admin, <product's provider>, <product_key>, <account_key>, 'main', D, <principal>, <rate>, <365|366>, <interest>, 'accrual', 1, <rate row id>, <rate source_url>, 'estimated', <balance as_of, formula>)
  ON CONFLICT DO NOTHING;
  account_id and product_id are filled automatically by triggers; you may also set them explicitly.
- Slice Savings and Atom Savings are TWO independent accounts with their own balances and ledger rows. Never combine principals; never substitute one account's balance for the other.
- Corrections: on every run re-check past rows against the latest verified rates and balances. If a past calculation differs, keep the old row and insert a correction: same keys, revision = previous max + 1, entry_type 'correction', supersedes_id = id of the row being corrected, interest_amount = signed delta, notes with old/new principal, rate, formula and source. Idempotent: do not insert a correction that already exists.
- Accruals are estimates: never write them as income transactions and never change any balance from them.

5) ACTUAL INTEREST CREDITED (only with bank evidence from the user)
- When the user provides a bank screenshot or statement showing an interest credit, in ONE transaction:
  a) INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref) VALUES ($admin, 'income', 'Interest', <narration>, <amount>, '', <account id>, <credit date>, <bank reference>) — external_ref is unique per user, so a repeated reference is rejected (409/duplicate) instead of double-counted. Without a bank reference use 'interest:<account_key>:<date>:<amount>' as external_ref.
  b) INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note) VALUES (<account id>, <credit time>, <new verified balance>, 'verified', <evidence>) ON CONFLICT DO NOTHING;
  c) Until the dashboard is switched to the account model, also keep the legacy columns in step: UPDATE wealth_accounts SET current_balance=<new balance>, balance_as_of=<credit time>, balance_status='verified', updated_at=now() WHERE id=<account id>;
- Never infer a credit from an accrual.

6) SPENDING (verification only — nothing to roll over)
- Spending totals are computed live by the app from all wealth_transactions; there is no rollover table and nothing to reset. Report, for the IST calendar: yesterday, week to date, month to date and year to date expense totals and counts:
  SELECT sum(amount), count(*) FROM wealth_transactions WHERE user_id=$admin AND kind='expense' AND occurred_on BETWEEN <from> AND <to>;
- Do not invent totals; if the query fails, report it.

7) VERIFY AND REPORT (never claim success unless verified in production)
- Re-read what you wrote: per account and date, ledger rows (revision, interest_amount) and sums; rate periods (open ones per product).
- Report:
  • RBI repo rate (context), each product's rate with effective date and source URL;
  • for EACH source separately: name, account_key, principal and balance date, rate % p.a., day count, daily estimated accrual per date written, status (calculated / pending verification / stale / needs link);
  • Slice FD and Angel One FD explicitly, even when pending;
  • accounts discovered without a product/rate link;
  • corrections/revisions written; ledger row counts and sums per account; combined estimated interest as a separate summary line;
  • any actual credits recorded (with reference);
  • spending totals;
  • every missing or stale input. Distinguish estimated accrual from credited interest.
