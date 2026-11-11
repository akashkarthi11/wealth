-- 0021: paid shares and round-off (owner 2026-11-11: "in lend paid button, split paid option", "roundoff mean close all
-- lend and create one new lend with reference of all closed and count total and decide how much already back").
--   wealth_person_entries.split_id   a payment back for one bill share ("Mark paid" on a split share).
--   wealth_person_rollups            a round-off: everything open with a person is closed into it — total owed at that
--                                    moment, how much was already back (not recorded before), and the new amount carried.
--   rollup_id                        on entries and shares: closed by that round-off (kept as history, no longer counted).
--   rollup_ref                       on the new entry the round-off opened ("carried from round-off …").
-- Additive; nothing is deleted.
CREATE TABLE IF NOT EXISTS wealth_person_rollups (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES wealth_people(id) ON DELETE CASCADE,
  closed_on     date NOT NULL,
  total_owed    numeric(18,2) NOT NULL CHECK (total_owed >= 0),
  already_back  numeric(18,2) NOT NULL DEFAULT 0 CHECK (already_back >= 0),
  new_amount    numeric(18,2) NOT NULL CHECK (new_amount >= 0),
  closed_items  int NOT NULL DEFAULT 0,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_person_rollups_person_idx ON wealth_person_rollups (person_id, closed_on);

ALTER TABLE wealth_person_entries ADD COLUMN IF NOT EXISTS split_id uuid REFERENCES wealth_bill_splits(id) ON DELETE SET NULL;
ALTER TABLE wealth_person_entries ADD COLUMN IF NOT EXISTS rollup_id uuid REFERENCES wealth_person_rollups(id) ON DELETE SET NULL;
ALTER TABLE wealth_person_entries ADD COLUMN IF NOT EXISTS rollup_ref uuid REFERENCES wealth_person_rollups(id) ON DELETE SET NULL;
ALTER TABLE wealth_bill_split_shares ADD COLUMN IF NOT EXISTS rollup_id uuid REFERENCES wealth_person_rollups(id) ON DELETE SET NULL;
-- A share is marked paid once.
CREATE UNIQUE INDEX IF NOT EXISTS wealth_person_entries_share_paid_uniq ON wealth_person_entries (person_id, split_id) WHERE split_id IS NOT NULL;

DROP TRIGGER IF EXISTS wealth_person_rollups_audit ON wealth_person_rollups;
CREATE TRIGGER wealth_person_rollups_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_person_rollups FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_person_rollups_data_version ON wealth_person_rollups;
CREATE TRIGGER wealth_person_rollups_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_person_rollups FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
