-- 0033: the account that receives a reward's cashback (owner, 2026-11-14). Cashback is often credited to a different account than the
-- card that earned it (for example Slice Savings). An offer can name its receiving account (empty = the same account as the payment),
-- and each earning remembers the account it was credited to, which the owner can change on the payment. Additive: two nullable columns.
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS receive_account_id uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS receive_account_id uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL;
