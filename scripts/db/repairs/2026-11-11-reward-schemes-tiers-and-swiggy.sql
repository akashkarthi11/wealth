-- 2026-11-11 · owner: "after reach 300000 monies its 1.5 % after 5l its 2%" and "hdfc provide 5% when i buy in swiggy with
-- hdfc card", "every card spend it add against monis" (checked: +21 Monies 9→11 Nov = 1% of the ₹21 Slice card spend;
-- Slice Savings spends earned none). Updates the Slice Monies scheme tiers and adds a spend scheme to HDFC Swiggy Orange. Idempotent.
--   Slice Monies:        1% of Slice CREDIT CARD spends · 1.5% from 3,00,000 Monies · 2% from 5,00,000 Monies
--   HDFC Swiggy Orange:  5% of Swiggy spends on this card, paid as ₹ cashback (monthly offers to be added when shared)
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
v (program_key, scheme, note) AS (VALUES
  ('slice-monies', '{"basis": "spend", "rate": 0.01, "spend_bank": "Slice", "spend_account_type": "credit_card", "label": "Slice card spends", "tiers": [{"at": 300000, "rate": 0.015, "label": "1.5% rate"}, {"at": 500000, "rate": 0.02, "label": "Locked rate 2%"}]}'::jsonb,
   'Earn 1% of Slice credit card spends as Monies (₹1 spent ≈ 1 Monie); 1.5% from 3,00,000 Monies and 2% from 5,00,000. One screen showed ₹0 cash, another ₹1,423.78 — confirm which is withdrawable.'),
  ('hdfc-swiggy-orange', '{"basis": "spend", "rate": 0.05, "spend_scope": "account", "merchant": "swiggy", "label": "Swiggy orders on this card"}'::jsonb,
   'HDFC Swiggy Orange: 5% cashback on Swiggy spends with this card, credited to the card. Monthly offers to be added. Reward points shown 0 on 8 Nov.'))
UPDATE wealth_reward_programs p SET scheme = v.scheme, redeem_note = v.note, updated_at = now()
FROM v, o WHERE p.user_id = o.id AND p.program_key = v.program_key AND p.scheme IS DISTINCT FROM v.scheme;
COMMIT;
