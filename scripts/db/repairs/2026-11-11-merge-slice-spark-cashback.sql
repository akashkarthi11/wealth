-- 2026-11-11 · owner: "spark vs slice card cash back" → "merge it 1": show Slice card cashback and Spark as ONE program.
-- The card program becomes "Slice cashback (card + Spark)": it sums the Slice card's merchant cashback (category
-- "Credit card cashback", only on the Slice card) and the "Spark cashback" credits (imported without an account), so
-- it counts from any account — checked on 2026-11-11: those two patterns match only these 24 + 3 credits (₹3,115.85).
-- The separate Spark program is CLOSED (hidden, not deleted). Transactions are not changed. Idempotent.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
UPDATE wealth_reward_programs p
SET name = 'Slice cashback (card + Spark)', cash_match = 'credit card cashback|spark', cash_any_account = true,
    redeem_note = 'Slice card merchant cashback (May–Jul 2026) and Spark cashback (from Nov 2026), credited as money; totals come from transactions. No card cashback is recorded for Aug–Oct 2026.',
    updated_at = now()
FROM o WHERE p.user_id = o.id AND p.program_key = 'slice-card-cashback' AND p.name <> 'Slice cashback (card + Spark)';
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
UPDATE wealth_reward_programs p SET status = 'closed', redeem_note = 'Merged into "Slice cashback (card + Spark)" on 11 Nov 2026.', updated_at = now()
FROM o WHERE p.user_id = o.id AND p.program_key = 'slice-spark' AND p.status = 'active';
COMMIT;
