-- 2026-11-11 · owner: "for monis there are reward scheme"; basis confirmed: "% of my spends".
-- Slice Monies scheme from the 9 Nov screenshot: reward rate 1 % of spends, locked reward rate 2 % from 5,00,000 Monies.
-- With 1 Monie = ₹0.01 (same screen), 1 % of ₹1 spent ≈ 1 Monie. Spends counted: expenses on Slice accounts (assumption,
-- shown on the card). Sets the scheme only when it is empty; nothing else changes. Needs migration 0016.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_reward_programs p
SET scheme = '{"basis": "spend", "rate": 0.01, "spend_bank": "Slice", "tiers": [{"at": 500000, "rate": 0.02, "label": "Locked rate 2%"}]}'::jsonb,
    redeem_note = 'Earn 1% of Slice spends as Monies; the locked rate of 2% unlocks at 5,00,000 Monies. One screen showed ₹0 cash, another ₹1,423.78 — confirm which is withdrawable.',
    updated_at = now()
FROM (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1) o
WHERE p.user_id = o.id AND p.program_key = 'slice-monies' AND p.scheme IS NULL;
COMMIT;
