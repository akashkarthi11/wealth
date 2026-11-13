-- 0029: accept a transaction (owner, 2026-11-14). New transactions wait as 'pending'; Accept writes a new balance on the
-- source account (last balance plus or minus the amount) and finds the account's offers. Rows that exist today have no
-- review_status (NULL) and never appear in the pending list. Additive only.
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS review_status text CHECK (review_status IN ('pending', 'accepted', 'dismissed'));
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS applied_balance_as_of timestamptz;
ALTER TABLE wealth_transactions ALTER COLUMN review_status SET DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS wealth_transactions_pending_idx ON wealth_transactions (user_id, occurred_on DESC) WHERE review_status = 'pending';
