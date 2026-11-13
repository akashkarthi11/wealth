-- 0030: account offers (owner, 2026-11-14). Card / account offers kept on a screen (HDFC Swiggy, Slice UPI, Sparks ...). On Accept of a
-- payment, the offers of the payment's account that match the payee, the way it was paid, the day and the limits are shown, and the
-- owner can record that an offer was used (so one-time offers and per-month limits are counted). Additive: two new tables.
CREATE TABLE IF NOT EXISTS wealth_account_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES wealth_accounts(id) ON DELETE CASCADE,
  title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  merchants        text[] NOT NULL DEFAULT '{}',
  payment_mode     text NOT NULL DEFAULT 'any' CHECK (payment_mode IN ('any', 'upi', 'card')),
  weekdays         smallint[] NOT NULL DEFAULT '{}',
  coupon_code      text,
  benefit_type     text NOT NULL CHECK (benefit_type IN ('percent', 'flat')),
  benefit_value    numeric(12,2) NOT NULL CHECK (benefit_value > 0),
  max_benefit      numeric(12,2) CHECK (max_benefit IS NULL OR max_benefit > 0),
  min_spend        numeric(14,2) CHECK (min_spend IS NULL OR min_spend >= 0),
  reward_unit      text NOT NULL DEFAULT 'cashback' CHECK (reward_unit IN ('cashback', 'points', 'coins', 'monies', 'coupon', 'discount')),
  frequency        text NOT NULL DEFAULT 'unlimited' CHECK (frequency IN ('unlimited', 'one_time', 'limited')),
  max_uses         integer CHECK (max_uses IS NULL OR max_uses >= 1),
  period           text NOT NULL DEFAULT 'none' CHECK (period IN ('none', 'day', 'week', 'month', 'cycle', 'year')),
  cycle_day        smallint CHECK (cycle_day IS NULL OR cycle_day BETWEEN 1 AND 28),
  period_max_uses  integer CHECK (period_max_uses IS NULL OR period_max_uses >= 1),
  period_max_benefit numeric(12,2) CHECK (period_max_benefit IS NULL OR period_max_benefit > 0),
  valid_from       date,
  valid_to         date,
  active           boolean NOT NULL DEFAULT true,
  verify_status    text NOT NULL DEFAULT 'to_verify' CHECK (verify_status IN ('to_verify', 'verified')),
  source_url       text,
  notes            text,
  last_checked_on  date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_account_offers_user_idx ON wealth_account_offers (user_id, account_id);

-- Each time the owner says "I used this offer" on a payment.
CREATE TABLE IF NOT EXISTS wealth_offer_uses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  offer_id       uuid NOT NULL REFERENCES wealth_account_offers(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  used_on        date NOT NULL,
  benefit        numeric(12,2) NOT NULL CHECK (benefit >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_offer_uses_offer_idx ON wealth_offer_uses (offer_id, used_on);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_offer_uses_tx_uq ON wealth_offer_uses (offer_id, transaction_id) WHERE transaction_id IS NOT NULL;

DROP TRIGGER IF EXISTS wealth_account_offers_audit ON wealth_account_offers;
CREATE TRIGGER wealth_account_offers_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_account_offers FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_account_offers_data_version ON wealth_account_offers;
CREATE TRIGGER wealth_account_offers_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_account_offers FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
DROP TRIGGER IF EXISTS wealth_offer_uses_audit ON wealth_offer_uses;
CREATE TRIGGER wealth_offer_uses_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_offer_uses FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_offer_uses_data_version ON wealth_offer_uses;
CREATE TRIGGER wealth_offer_uses_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_offer_uses FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
