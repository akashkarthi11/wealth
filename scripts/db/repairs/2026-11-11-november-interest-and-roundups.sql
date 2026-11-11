-- 2026-11-11 · owner: "yes, approve interest fix" (issue.md on development: cumulative totals recorded as new rows).
-- 1) November interest was recorded as month-to-date totals AND as daily/partial rows, so income counted several times:
--    Slice Savings: ₹71.57 on 11 Nov is the total through 10 Nov (₹57.15 MTD on 9 Nov + ₹7.21 + ₹7.21). The rows
--      ₹35.53 (6 Nov), ₹42.74 (7 Nov), ₹7.20 (8 Nov), ₹7.21 (10 Nov) are inside it → marked duplicate_of the ₹71.57 row.
--    Atom Savings ("Slice Atom"): ₹76.36 on 11 Nov is the total through 10 Nov (₹57.24 + ₹9.56 × 2). The rows ₹9.55 (8 Nov)
--      and ₹9.56 (10 Nov) are inside it → marked duplicate_of the ₹76.36 row.
--    Overstatement removed: ₹92.68 + ₹19.11 = ₹111.79. Nothing is deleted; marked rows drop out of totals.
-- 2) Round-ups belong to Slice Atom = Atom Savings (owner confirmed): the 7 Nov ₹141 and 11 Nov ₹18 round-up transfers
--    move from Slice Savings ••3731 to Atom Savings.
-- Safety: the script stops unless it finds exactly the expected rows; re-running changes nothing.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
CREATE TEMP TABLE fix_rows ON COMMIT DROP AS
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
slice AS (SELECT a.id FROM wealth_accounts a JOIN o ON o.id = a.user_id WHERE a.bank_name = 'Slice' AND a.account_type = 'savings' AND a.masked_identifier = '••3731'),
atom AS (SELECT a.id FROM wealth_accounts a JOIN o ON o.id = a.user_id WHERE a.bank_name = 'Atom' AND a.account_name = 'Atom Savings'),
keep_slice AS (SELECT t.id FROM wealth_transactions t, o, slice WHERE t.user_id = o.id AND t.account_id = slice.id AND t.occurred_on = '2026-11-11' AND t.amount = 71.57 AND t.kind = 'income'),
keep_atom AS (SELECT t.id FROM wealth_transactions t, o, atom WHERE t.user_id = o.id AND t.account_id = atom.id AND t.occurred_on = '2026-11-11' AND t.amount = 76.36 AND t.kind = 'income')
SELECT 'dup' AS action, t.id, (SELECT id FROM keep_slice) AS target FROM wealth_transactions t, o
 WHERE t.user_id = o.id AND t.kind = 'income' AND t.duplicate_of IS NULL AND (
   (t.occurred_on = '2026-11-06' AND t.amount = 35.53 AND t.description LIKE 'November savings interest%') OR
   (t.occurred_on = '2026-11-07' AND t.amount = 42.74 AND t.description LIKE 'November savings interest%') OR
   (t.occurred_on = '2026-11-08' AND t.amount = 7.20  AND t.description LIKE 'November savings interest%') OR
   (t.occurred_on = '2026-11-10' AND t.amount = 7.21  AND t.description LIKE 'Slice Savings daily interest credit%'))
UNION ALL
SELECT 'dup', t.id, (SELECT id FROM keep_atom) FROM wealth_transactions t, o
 WHERE t.user_id = o.id AND t.kind = 'income' AND t.duplicate_of IS NULL AND (
   (t.occurred_on = '2026-11-08' AND t.amount = 9.55 AND t.description LIKE 'November Atom interest%') OR
   (t.occurred_on = '2026-11-10' AND t.amount = 9.56 AND t.description LIKE 'Slice Atom daily interest credit%'))
UNION ALL
SELECT 'move', t.id, (SELECT id FROM atom) FROM wealth_transactions t, o, slice
 WHERE t.user_id = o.id AND t.kind = 'transfer' AND t.account_id = slice.id AND t.description = 'November round-ups'
   AND ((t.occurred_on = '2026-11-07' AND t.amount = 141) OR (t.occurred_on = '2026-11-11' AND t.amount = 18));
DO $$
DECLARE n_dup int; n_move int; n_null int;
BEGIN
  SELECT count(*) FILTER (WHERE action = 'dup'), count(*) FILTER (WHERE action = 'move'), count(*) FILTER (WHERE target IS NULL) INTO n_dup, n_move, n_null FROM fix_rows;
  IF n_null > 0 THEN RAISE EXCEPTION 'a keep/target row was not found (% rows without target)', n_null; END IF;
  IF NOT ((n_dup = 6 AND n_move = 2) OR (n_dup = 0 AND n_move = 0)) THEN
    RAISE EXCEPTION 'expected 6 duplicates and 2 moves (or 0 and 0 on a re-run), found % and %', n_dup, n_move;
  END IF;
END $$;
UPDATE wealth_transactions t SET duplicate_of = f.target, duplicate_marked_at = now() FROM fix_rows f WHERE f.action = 'dup' AND t.id = f.id;
UPDATE wealth_transactions t SET account_id = f.target, account = 'Atom Savings' FROM fix_rows f WHERE f.action = 'move' AND t.id = f.id;
COMMIT;
