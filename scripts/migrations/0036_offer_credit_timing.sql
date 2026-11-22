-- 0036: when a bank credits the cashback (owner, 2026-11-14). Most cashback can go into the history as soon as the payment is accepted
-- ('now', the default). Some banks credit it only after the statement is settled ('settle'): the reward then stays expected, nothing is
-- written to the history or the balance, and when the owner marks it received the "Cashback" entry is added on that day.
-- Additive: one column with a default.
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS credit_timing text NOT NULL DEFAULT 'now' CHECK (credit_timing IN ('now', 'settle'));
