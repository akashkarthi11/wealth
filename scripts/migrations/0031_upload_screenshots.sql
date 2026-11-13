-- 0031: payment screenshots uploaded by a user (owner, 2026-11-14). The Upload page accepts a screenshot; the app reads it with a vision
-- model (Vercel AI Gateway), creates the payments for that user as 'pending' transactions (the user then Accepts or Dismisses them), and
-- clears the image. This table is the log of what was uploaded and read: it stops the same screenshot being read twice (fingerprint),
-- and holds the image only until it has been read. Additive: one new table.
-- No audit trigger on purpose: the audit log copies whole rows and would copy the image bytes.
CREATE TABLE IF NOT EXISTS wealth_upload_screenshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  file_name   text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  mime_type   text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 3145728),
  fingerprint text NOT NULL,
  image       bytea,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'failed', 'removed')),
  found       integer,
  note        text CHECK (note IS NULL OR length(note) <= 600),
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
-- The same image twice from the same user is refused (a removed one may be uploaded again).
CREATE UNIQUE INDEX IF NOT EXISTS wealth_upload_screenshots_fp_uq ON wealth_upload_screenshots (user_id, fingerprint) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS wealth_upload_screenshots_user_idx ON wealth_upload_screenshots (user_id, created_at DESC);
