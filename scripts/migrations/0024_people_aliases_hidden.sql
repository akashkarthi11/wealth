-- 0024: other names and hiding for people (owner 2026-11-11: "rename … map this transaction to this user, if same user
-- transfer we need to consider that same user we created … dont show in that user list if i ask to hide … dont show
-- transaction related to that user in screen but background store it").
--   wealth_person_aliases   other names a person appears under in bank text ("Mr Arun S", "ARUN S"); one per user per
--                           name, so the same name always maps to the same person. Renaming keeps the old name here.
--   wealth_people.hidden    hidden from lists, pickers, suggestions, notifications and Activity; all data kept.
-- Additive; nothing is deleted.
ALTER TABLE wealth_people ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS wealth_person_aliases (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES wealth_people(id) ON DELETE CASCADE,
  alias       text NOT NULL CHECK (length(trim(alias)) > 0),
  alias_key   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_person_aliases_key UNIQUE (user_id, alias_key)
);
CREATE INDEX IF NOT EXISTS wealth_person_aliases_person_idx ON wealth_person_aliases (person_id);

DROP TRIGGER IF EXISTS wealth_person_aliases_audit ON wealth_person_aliases;
CREATE TRIGGER wealth_person_aliases_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_person_aliases FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_person_aliases_data_version ON wealth_person_aliases;
CREATE TRIGGER wealth_person_aliases_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_person_aliases FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
