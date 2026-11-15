-- 0035: fixed deposits on the Interest page (2026-11-14). The owner adds an FD with its rate per year and deposit terms; an FD that
-- pays its interest out (monthly, quarterly, yearly) pays it into one of the owner's savings or current accounts. Additive only.
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS payout_account_id uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL;
