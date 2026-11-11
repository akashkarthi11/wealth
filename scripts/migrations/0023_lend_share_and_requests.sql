-- 0023: share a person's lending summary by link, and their "I've paid" requests (owner 2026-11-11: "gen url for user in
-- lend so they can see their lend and after paid then ask request to close … notification … if i close it need to add
-- balance to bank and close lend").
--   wealth_people.share_token_hash   SHA-256 of the link's secret (the link itself is shown once; a new link replaces it).
--   wealth_lend_requests             a person says they paid (amount, date, how, note). The owner accepts (money recorded
--                                    on a bank account as a received transfer + a "paid back" entry; optionally added to
--                                    that account's balance; optionally the lend is closed) or declines. Nothing deleted.
ALTER TABLE wealth_people ADD COLUMN IF NOT EXISTS share_token_hash text;
ALTER TABLE wealth_people ADD COLUMN IF NOT EXISTS share_created_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_people_share_uniq ON wealth_people (share_token_hash) WHERE share_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS wealth_lend_requests (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id        uuid NOT NULL REFERENCES wealth_people(id) ON DELETE CASCADE,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on          date NOT NULL,
  method           text NOT NULL DEFAULT 'upi' CHECK (method IN ('upi', 'bank', 'cash', 'other')),
  note             text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  accepted_amount  numeric(18,2),
  account_id       uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL,
  transaction_id   uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  balance_added    boolean NOT NULL DEFAULT false,
  closed_lend      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS wealth_lend_requests_person_idx ON wealth_lend_requests (person_id, status, created_at);

DROP TRIGGER IF EXISTS wealth_lend_requests_audit ON wealth_lend_requests;
CREATE TRIGGER wealth_lend_requests_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_lend_requests FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_lend_requests_data_version ON wealth_lend_requests;
CREATE TRIGGER wealth_lend_requests_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_lend_requests FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
