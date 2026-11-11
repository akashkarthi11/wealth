-- 0019: account splits — pots inside one account (owner 2026-11-11: Atom has Invest later, Rent, Emergency fund, Round ups;
-- "add or remove against that ... i will pay rent you need to reduce against rent in atom").
-- A split has a balance history (verified from a screenshot, or estimated) and signed movements: + money into the split
-- (e.g. a round-up), − money out (e.g. rent paid from the Rent split). A movement may point at the transaction behind it.
-- Estimated split balance = last balance + movements after it. Splits are views of money inside the account: they never
-- change account balances or totals (the account is counted once). Additive: three tables + audit + data-version triggers.
CREATE TABLE IF NOT EXISTS wealth_account_splits (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES wealth_accounts(id) ON DELETE CASCADE,
  split_key    text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'goal' CHECK (kind IN ('goal', 'roundups', 'general')),
  goal_amount  numeric(18,2) CHECK (goal_amount IS NULL OR goal_amount >= 0),
  purpose      text,
  sort_order   int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_account_splits_key UNIQUE (account_id, split_key)
);

CREATE TABLE IF NOT EXISTS wealth_account_split_balances (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  split_id    uuid NOT NULL REFERENCES wealth_account_splits(id) ON DELETE CASCADE,
  as_of       timestamptz NOT NULL,
  balance     numeric(18,2) NOT NULL,
  status      text NOT NULL CHECK (status IN ('verified', 'estimated')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_account_split_balances_point UNIQUE (split_id, as_of)
);

CREATE TABLE IF NOT EXISTS wealth_account_split_moves (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  split_id        uuid NOT NULL REFERENCES wealth_account_splits(id) ON DELETE CASCADE,
  occurred_at     timestamptz NOT NULL,
  amount          numeric(18,2) NOT NULL CHECK (amount <> 0),          -- + into the split, − out of it
  transaction_id  uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_account_split_moves_split_idx ON wealth_account_split_moves (split_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_account_split_moves_tx_uniq ON wealth_account_split_moves (split_id, transaction_id) WHERE transaction_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wealth_account_splits', 'wealth_account_split_balances', 'wealth_account_split_moves'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit()', t || '_audit', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_data_version', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version()', t || '_data_version', t);
  END LOOP;
END $$;
