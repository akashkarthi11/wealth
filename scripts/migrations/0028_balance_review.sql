-- 0028: balance review (owner, 2026-11-14). A balance written by the assistant from a screenshot is stored as 'reported',
-- not 'verified', and waits in Data quality for Confirm or Reject. Additive: new columns, and the latest-balance view now
-- skips a rejected balance (the row is kept, never deleted).
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS entered_by text;
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS confirmed_by text;
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS rejected_by text;
ALTER TABLE wealth_account_balances ADD COLUMN IF NOT EXISTS rejected_reason text;
CREATE OR REPLACE VIEW wealth_v_latest_balances AS
SELECT DISTINCT ON (account_id) account_id, as_of, balance, status, note
FROM wealth_account_balances
WHERE rejected_at IS NULL
ORDER BY account_id, as_of DESC;
