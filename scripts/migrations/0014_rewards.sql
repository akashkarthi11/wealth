-- 0014: rewards & points (TSD Claude Plan 4, Part A — TR4-A.1…A.3). Owner: "a" (start Part A).
-- One program per reward scheme (Paytm Gold Coins, Slice Monies, Slice Spark, Roarbank rewards, HDFC card rewards …),
-- an append-only balance history (newest row = current), and earned / redeemed / expired events.
-- Cashback paid as money stays an income transaction; it is never stored again here (TR4-A.4).
-- ₹ value = units × inr_per_unit only when a rate with a source is recorded; otherwise units only.
-- Rewards are shown apart from net worth (decision D2 default). Additive: three new tables + audit triggers.
CREATE TABLE IF NOT EXISTS wealth_reward_programs (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  program_key   text NOT NULL,                                   -- e.g. 'paytm-gold-coins'
  provider      text NOT NULL,                                   -- 'Paytm', 'Slice', 'Roarbank', 'HDFC Bank'
  name          text NOT NULL,
  unit          text NOT NULL,                                   -- 'Gold Coins', 'Monies', 'points', '₹ cashback'
  account_id    uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL,
  inr_per_unit  numeric(18,6) CHECK (inr_per_unit IS NULL OR inr_per_unit >= 0),
  rate_source   text,                                            -- where the ₹ rate comes from
  rate_as_of    date,
  min_redeem    numeric(18,2) CHECK (min_redeem IS NULL OR min_redeem >= 0),
  redeem_note   text,
  expiry_note   text,
  cash_match    text,                                            -- programs paid as money (e.g. Slice Spark): regex on income
                                                                 -- transactions' category + description; summed, never copied
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_reward_programs_key UNIQUE (user_id, program_key),
  CONSTRAINT wealth_reward_programs_rate_source CHECK (inr_per_unit IS NULL OR rate_source IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS wealth_reward_balances (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  program_id  uuid NOT NULL REFERENCES wealth_reward_programs(id) ON DELETE CASCADE,
  as_of       timestamptz NOT NULL,
  units       numeric(18,2) NOT NULL CHECK (units >= 0),
  status      text NOT NULL CHECK (status IN ('verified', 'estimated')),
  expires_on  date,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_reward_balances_point UNIQUE (program_id, as_of)
);
CREATE INDEX IF NOT EXISTS wealth_reward_balances_latest_idx ON wealth_reward_balances (program_id, as_of DESC);

CREATE TABLE IF NOT EXISTS wealth_reward_events (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  program_id      uuid NOT NULL REFERENCES wealth_reward_programs(id) ON DELETE CASCADE,
  occurred_on     date NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('earned', 'redeemed', 'expired', 'adjusted')),
  units           numeric(18,2) NOT NULL,
  inr_value       numeric(18,2),
  transaction_id  uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_reward_events_program_idx ON wealth_reward_events (program_id, occurred_on DESC);

DROP TRIGGER IF EXISTS wealth_reward_programs_audit ON wealth_reward_programs;
CREATE TRIGGER wealth_reward_programs_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_reward_programs FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_reward_balances_audit ON wealth_reward_balances;
CREATE TRIGGER wealth_reward_balances_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_reward_balances FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_reward_events_audit ON wealth_reward_events;
CREATE TRIGGER wealth_reward_events_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_reward_events FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
