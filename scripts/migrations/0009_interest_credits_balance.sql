-- 0009: daily-credited interest raises the account balance (owner decision 2026-11-11: "Estimated").
-- Additive: one column, a widened status check. No rows are removed or changed except setting the new column.

-- How often the bank pays the interest into the account. Only 'daily' products raise the balance every night.
ALTER TABLE wealth_interest_products ADD COLUMN IF NOT EXISTS credit_frequency text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_interest_products_credit_frequency_check') THEN
    ALTER TABLE wealth_interest_products ADD CONSTRAINT wealth_interest_products_credit_frequency_check
      CHECK (credit_frequency IS NULL OR credit_frequency IN ('daily', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'on_maturity'));
  END IF;
END $$;
-- Slice Savings and Slice Atom credit interest daily (bank screenshots, 8–10 Nov 2026: per-day credits).
UPDATE wealth_interest_products SET credit_frequency = 'daily'
WHERE product_key IN ('slice-savings', 'atom-savings') AND credit_frequency IS NULL;

-- Balance history gains 'estimated': last verified balance + interest credited since. Counted in net worth,
-- replaced in the "latest balance" view by the next verified balance.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_account_balances_status_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%estimated%') THEN
    ALTER TABLE wealth_account_balances DROP CONSTRAINT wealth_account_balances_status_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_account_balances_status_check') THEN
    ALTER TABLE wealth_account_balances ADD CONSTRAINT wealth_account_balances_status_check
      CHECK (status IN ('verified', 'reported', 'pending_reconciliation', 'estimated'));
  END IF;
END $$;
