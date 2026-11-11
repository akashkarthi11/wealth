-- 2026-11-11 · owner: interest from screenshots must not be stored ("it will already handle by task") → "find real amount and
-- replace here". The two November interest rows that came from screenshots are replaced by the app's own figures
-- (interest statement 1–9 Nov + nightly accrual 10 Nov) and handed to the nightly task, which keeps them current:
--   Slice Savings ••3731: ₹71.57 (screenshot) → ₹71.58 = ₹64.36 + ₹7.2151   Atom Savings: ₹76.36 = ₹66.80 + ₹9.5564
-- external_ref 'interest-month:<product>:<YYYY-MM>' marks them as the task's month-to-date rows. Nothing deleted; idempotent.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_transactions t SET amount = v.amount, category = 'Interest', occurred_on = '2026-11-10',
  description = v.descr, external_ref = v.ref
FROM (VALUES
  ('596bf851-eb4a-438c-be5b-3f8aacc003a7'::uuid, 71.58, 'Slice Savings interest · Nov 2026 to date (app: statement 1–9 Nov + nightly accrual)', 'interest-month:slice-savings:2026-11'),
  ('39eb5d73-6f72-4dfc-8a1f-345b2e48534a'::uuid, 76.36, 'Atom Savings interest · Nov 2026 to date (app: statement 1–9 Nov + nightly accrual)',  'interest-month:atom-savings:2026-11')
) v(id, amount, descr, ref)
WHERE t.id = v.id AND t.external_ref IS DISTINCT FROM v.ref;
COMMIT;
