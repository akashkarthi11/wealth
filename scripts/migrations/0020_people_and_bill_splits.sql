-- 0020: money lent and bill splits (TSD Claude Plan 4, Part B; owner 2026-11-11: "i need bill amount and split with
-- person or choose amount for each person and split gst to all", "in loan summary i can see who i gave this amount").
--   wealth_people              the owner's own contact list (people / P2P platforms — not app users; names only, no
--                              phone numbers or UPI IDs), with optional due date, interest rate and status.
--   wealth_person_entries      money between the owner and a person: 'out' = lent / paid for them, 'in' = paid back.
--                              Usually linked to the owner's transfer transaction (which stays a transfer).
--   wealth_bill_splits         a bill split: total, GST / tax inside it, how it was split, optional linked transaction.
--   wealth_bill_split_shares   each person's share (person_id NULL = the owner): base + tax share = amount.
-- What a person owes = their bill shares + money lent − money paid back (+ simple interest when a rate is set).
-- Not part of net worth (owner decision D2, default "separate line"). Nothing is deleted: a split is cancelled instead.
CREATE TABLE IF NOT EXISTS wealth_people (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  kind         text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'p2p_platform')),
  due_on       date,
  annual_rate  numeric(9,6) CHECK (annual_rate IS NULL OR (annual_rate >= 0 AND annual_rate <= 1)),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'written_off')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_people_name_uniq ON wealth_people (user_id, lower(name));

CREATE TABLE IF NOT EXISTS wealth_person_entries (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id       uuid NOT NULL REFERENCES wealth_people(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('out', 'in')),
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  occurred_on     date NOT NULL,
  transaction_id  uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_person_entries_person_idx ON wealth_person_entries (person_id, occurred_on);
-- A transfer belongs to one person only.
CREATE UNIQUE INDEX IF NOT EXISTS wealth_person_entries_tx_uniq ON wealth_person_entries (transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wealth_bill_splits (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  transaction_id  uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  title           text NOT NULL,
  occurred_on     date NOT NULL,
  total           numeric(18,2) NOT NULL CHECK (total > 0),
  tax             numeric(18,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  mode            text NOT NULL CHECK (mode IN ('equal', 'amounts')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_bill_splits_tax_le_total CHECK (tax <= total)
);
CREATE INDEX IF NOT EXISTS wealth_bill_splits_user_idx ON wealth_bill_splits (user_id, occurred_on);
-- One active split per transaction (cancel it to split again).
CREATE UNIQUE INDEX IF NOT EXISTS wealth_bill_splits_tx_uniq ON wealth_bill_splits (transaction_id) WHERE transaction_id IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS wealth_bill_split_shares (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  split_id   uuid NOT NULL REFERENCES wealth_bill_splits(id) ON DELETE CASCADE,
  person_id  uuid REFERENCES wealth_people(id) ON DELETE CASCADE,      -- NULL = the owner's own share
  base       numeric(18,2) NOT NULL CHECK (base >= 0),
  tax        numeric(18,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  amount     numeric(18,2) NOT NULL CHECK (amount >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_bill_split_shares_person_uniq ON wealth_bill_split_shares (split_id, person_id) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_bill_split_shares_me_uniq ON wealth_bill_split_shares (split_id) WHERE person_id IS NULL;
CREATE INDEX IF NOT EXISTS wealth_bill_split_shares_person_idx ON wealth_bill_split_shares (person_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wealth_people', 'wealth_person_entries', 'wealth_bill_splits', 'wealth_bill_split_shares'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit()', t || '_audit', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_data_version', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version()', t || '_data_version', t);
  END LOOP;
END $$;
