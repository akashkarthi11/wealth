-- 0017: every reward program is linked to an account (owner 2026-11-11: "every thing link to account").
-- A cash program normally sums only the cashback credited to its linked account; some credits (e.g. Slice "Spark
-- cashback") were imported without an account, so the program can opt in to counting matching credits on any account.
ALTER TABLE wealth_reward_programs ADD COLUMN IF NOT EXISTS cash_any_account boolean NOT NULL DEFAULT false;
