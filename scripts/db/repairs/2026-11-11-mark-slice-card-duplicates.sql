-- 2026-11-11 · Plan 3 TR3-1.3: mark the clear duplicate pairs on the Slice credit card (owner review).
-- A "clear" pair = same user, kind, amount, date, account and merchant, where one row came from the plain workbook import
-- ("Awfis") and the other from the Slice statement import ("Awfis · UPI · Slice statement"). The statement row is kept;
-- the plain row is MARKED (duplicate_of → the statement row) and drops out of totals. Nothing is deleted or rewritten.
-- Pairs where both rows come from the same import are left for the owner to review (7 pairs on 2026-11-11).
-- Idempotent: rows already marked are skipped.
-- Applied to Production 2026-11-11 (owner approval): UPDATE 93, ₹1,26,297.54; re-run marks 0.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);

WITH tagged AS (
  SELECT t.id, t.user_id, t.kind, t.amount, t.occurred_on, t.account_id, t.created_at,
         split_part(t.description, ' · ', 1) AS merchant,
         (t.description ~ ' · (UPI|Card|NEFT|IMPS|Net Banking)[^·]* · ' OR t.description ~ 'statement') AS from_statement
  FROM wealth_transactions t
  JOIN wealth_accounts acc ON acc.id = t.account_id AND acc.bank_name = 'Slice' AND acc.account_type = 'credit_card'
  WHERE t.duplicate_of IS NULL
),
ranked AS (               -- number plain rows and statement rows separately inside each identical group
  SELECT *, row_number() OVER (PARTITION BY user_id, kind, amount, occurred_on, account_id, merchant, from_statement ORDER BY created_at, id) AS n
  FROM tagged
),
one_to_one AS (           -- the 1st plain row pairs with the 1st statement row, the 2nd with the 2nd, and so on
  SELECT bare.id AS bare_id, stmt.id AS keep_id
  FROM ranked bare JOIN ranked stmt
    ON stmt.user_id = bare.user_id AND stmt.kind = bare.kind AND stmt.amount = bare.amount AND stmt.occurred_on = bare.occurred_on
   AND stmt.account_id = bare.account_id AND stmt.merchant = bare.merchant AND stmt.n = bare.n
  WHERE NOT bare.from_statement AND stmt.from_statement
)
UPDATE wealth_transactions t SET duplicate_of = o.keep_id, duplicate_marked_at = now()
FROM one_to_one o WHERE t.id = o.bare_id AND t.duplicate_of IS NULL;

COMMIT;
