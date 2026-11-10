-- 0001: session revocation (TSD TR-1.4).
-- Every session cookie carries the user's session_version; bumping it signs that user out everywhere.
ALTER TABLE wealth_users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_users_session_version_check') THEN
    ALTER TABLE wealth_users ADD CONSTRAINT wealth_users_session_version_check CHECK (session_version >= 1);
  END IF;
END $$;
