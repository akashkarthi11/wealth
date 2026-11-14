-- 0031: offers that work by themselves (owner, 2026-11-14). When a payment is accepted, the offers of its account that match are
-- applied: cashback is recorded as "expected" on that payment (shown on the Transactions page) and points are recorded against their
-- reward program (shown on the Rewards page). Nothing is written to the ledger as income: when the real credit arrives (an imported
-- cashback credit) it is linked to the expectation, so the same money is never counted twice.
-- Additive only. wealth_offer_uses becomes the earning record (one row per offer applied to a payment); it keeps its history when
-- the offer is deleted (the title is copied) and a removed earning is marked 'cancelled' instead of deleted.

-- Offers: maximum eligible payment (Spark style "min 249, max 5,000"), points per block of rupees, the reward program that
-- receives the points, automatic vs "ask me" (a Spark must be activated first), and "only the best of this group applies".
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS max_spend numeric(14,2) CHECK (max_spend IS NULL OR max_spend > 0);
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS block_amount numeric(12,2) CHECK (block_amount IS NULL OR block_amount > 0);
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES wealth_reward_programs(id) ON DELETE SET NULL;
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS apply_mode text NOT NULL DEFAULT 'auto' CHECK (apply_mode IN ('auto', 'ask'));
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS exclusive_group text CHECK (exclusive_group IS NULL OR length(btrim(exclusive_group)) BETWEEN 1 AND 40);
ALTER TABLE wealth_account_offers ADD COLUMN IF NOT EXISTS preset text;

-- benefit_type gains 'per_block'. The old check is found by what it says, not by the name Postgres gave it.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'wealth_account_offers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%benefit_type%' AND conname <> 'wealth_account_offers_block_check'
  LOOP
    EXECUTE format('ALTER TABLE wealth_account_offers DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE wealth_account_offers ADD CONSTRAINT wealth_account_offers_benefit_type_check CHECK (benefit_type IN ('percent', 'flat', 'per_block'));
ALTER TABLE wealth_account_offers DROP CONSTRAINT IF EXISTS wealth_account_offers_block_check;
ALTER TABLE wealth_account_offers ADD CONSTRAINT wealth_account_offers_block_check CHECK (benefit_type <> 'per_block' OR block_amount IS NOT NULL);
CREATE INDEX IF NOT EXISTS wealth_account_offers_program_idx ON wealth_account_offers (program_id) WHERE program_id IS NOT NULL;

-- Earnings: what an offer gave (or should give) on one payment.
--   kind    cashback / discount / coupon are money (benefit = ₹); points are reward units (units, and benefit = their ₹ value when known).
--   status  expected -> received (the credit arrived; optionally linked to the income transaction) ; cancelled (removed / payment reversed)
-- offer_id may become empty when the offer is deleted: the earning keeps its title.
ALTER TABLE wealth_offer_uses ALTER COLUMN offer_id DROP NOT NULL;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'wealth_offer_uses'::regclass AND contype = 'f' AND confrelid = 'wealth_account_offers'::regclass
  LOOP
    EXECUTE format('ALTER TABLE wealth_offer_uses DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE wealth_offer_uses ADD CONSTRAINT wealth_offer_uses_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES wealth_account_offers(id) ON DELETE SET NULL;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cashback' CHECK (kind IN ('cashback', 'points', 'discount', 'coupon'));
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS units numeric(18,2);
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES wealth_reward_programs(id) ON DELETE SET NULL;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS percent numeric(8,4);
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'received', 'cancelled'));
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS credited_transaction_id uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS credited_on date;
ALTER TABLE wealth_offer_uses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS wealth_offer_uses_tx_idx ON wealth_offer_uses (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wealth_offer_uses_program_idx ON wealth_offer_uses (program_id, used_on) WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wealth_offer_uses_user_status_idx ON wealth_offer_uses (user_id, status, used_on DESC);
-- An income transaction can be the credit of only one earning.
CREATE UNIQUE INDEX IF NOT EXISTS wealth_offer_uses_credit_uq ON wealth_offer_uses (credited_transaction_id) WHERE credited_transaction_id IS NOT NULL;
