-- 0026: remarks on lending rows (owner, 2026-11-12). On the shared page a person can add a comment against each row
-- (a lent / paid-back entry or a bill share); the owner answers from the People page and the answer shows on the shared
-- page too. Additive: one new table. Comments are kept, never deleted by the app.
CREATE TABLE IF NOT EXISTS wealth_lend_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES wealth_people(id) ON DELETE CASCADE,
  entry_id   uuid REFERENCES wealth_person_entries(id) ON DELETE CASCADE,
  share_id   uuid REFERENCES wealth_bill_split_shares(id) ON DELETE CASCADE,
  author     text NOT NULL CHECK (author IN ('person', 'owner')),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_id IS NOT NULL)::int + (share_id IS NOT NULL)::int = 1)
);
CREATE INDEX IF NOT EXISTS wealth_lend_comments_person_idx ON wealth_lend_comments (person_id, created_at);
CREATE INDEX IF NOT EXISTS wealth_lend_comments_entry_idx ON wealth_lend_comments (entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wealth_lend_comments_share_idx ON wealth_lend_comments (share_id) WHERE share_id IS NOT NULL;

DROP TRIGGER IF EXISTS wealth_lend_comments_audit ON wealth_lend_comments;
CREATE TRIGGER wealth_lend_comments_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_lend_comments FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_lend_comments_data_version ON wealth_lend_comments;
CREATE TRIGGER wealth_lend_comments_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_lend_comments FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
