# Scheduled task prompts — Wealth Ledger

Prompts for the owner's scheduled assistant tasks (ChatGPT). **Read [`rules.md`](rules.md) first; it always wins over this file.**
Keep this file on the `development` branch; the assistant reads it from there.

| Task | Schedule | Writes to the database |
|---|---|---|
| **Daily Wealth check** (below) | once a day, after 02:00 IST | only a changed interest rate (`wealth_interest_rates`) |
| Hourly Wealth operations | hourly | see the hourly prompt (prices, Gmail imports, Stock Advisor report) |

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
