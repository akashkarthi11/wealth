-- Apply only to Neon branch transaction-ingestion-test.
CREATE TABLE IF NOT EXISTS wealth_ingestion_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Android device',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS wealth_ingestion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('sms','email')),
  external_id text NOT NULL,
  bank_name text,
  direction text CHECK (direction IN ('debit','credit')),
  amount numeric(18,2),
  currency char(3) NOT NULL DEFAULT 'INR',
  occurred_at timestamptz,
  reference text,
  description text,
  raw_hash text NOT NULL,
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','duplicate','ignored','approved')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, source, external_id),
  UNIQUE(user_id, raw_hash)
);
CREATE INDEX IF NOT EXISTS wealth_ingestion_events_user_date_idx
  ON wealth_ingestion_events(user_id, occurred_at DESC);
