-- 0016: reward scheme per program (owner 2026-11-11: "for monis there are reward scheme" — % of spends).
-- scheme = {"basis": "spend", "rate": 0.01, "spend_bank": "Slice", "tiers": [{"at": 500000, "rate": 0.02, "label": "Locked rate"}]}
-- basis "spend": the program earns rate × spend (in ₹) as units worth inr_per_unit each; tiers unlock a higher rate at a
-- unit balance. Used to show progress to the next tier and an estimate of units earned from spends. Additive.
ALTER TABLE wealth_reward_programs ADD COLUMN IF NOT EXISTS scheme jsonb;
ALTER TABLE wealth_reward_programs DROP CONSTRAINT IF EXISTS wealth_reward_programs_scheme_object;
ALTER TABLE wealth_reward_programs ADD CONSTRAINT wealth_reward_programs_scheme_object CHECK (scheme IS NULL OR jsonb_typeof(scheme) = 'object');
