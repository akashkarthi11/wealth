-- 0034: interest set up by the owner (2026-11-14). On the Interest page the owner adds a savings or current account with its rate
-- per year and how often the bank pays the interest (every day, month, 2 months, quarter, half year or year). The app works the
-- interest out every night, lists it, and adds it to the balance when it is paid. Additive only.

-- An interest product can belong to one user (their own rate for their own account); NULL = the shared catalogue (Slice, Atom ...).
ALTER TABLE wealth_interest_products ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES wealth_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS wealth_interest_products_user_idx ON wealth_interest_products (user_id) WHERE user_id IS NOT NULL;

-- "Every 2 months" is a way of paying too.
ALTER TABLE wealth_interest_products DROP CONSTRAINT IF EXISTS wealth_interest_products_credit_frequency_check;
ALTER TABLE wealth_interest_products ADD CONSTRAINT wealth_interest_products_credit_frequency_check
  CHECK (credit_frequency IS NULL OR credit_frequency IN ('daily', 'monthly', 'bimonthly', 'quarterly', 'half_yearly', 'yearly', 'on_maturity'));

-- Per account (link): how the interest is paid (overrides the product), where the periods start, how old the balance used may be,
-- and a pause switch.
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS credit_frequency text
  CHECK (credit_frequency IS NULL OR credit_frequency IN ('daily', 'monthly', 'bimonthly', 'quarterly', 'half_yearly', 'yearly', 'on_maturity'));
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS credit_anchor date;
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS balance_max_age_days smallint CHECK (balance_max_age_days IS NULL OR balance_max_age_days BETWEEN 1 AND 120);
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
-- Daily interest in Transactions: one entry per month that grows every night (month, the Slice way) or a new entry every day (day).
ALTER TABLE wealth_interest_links ADD COLUMN IF NOT EXISTS record_mode text CHECK (record_mode IS NULL OR record_mode IN ('month', 'day'));

-- Interest rows the nightly job wrote after 0029 must not wait for review: Accept would add the interest to the balance a second time
-- (the job already raises the balance). They are the app's own records, like before 0029.
UPDATE wealth_transactions SET review_status = NULL
WHERE review_status = 'pending' AND kind = 'income' AND category = 'Interest' AND external_ref LIKE 'interest-%';
