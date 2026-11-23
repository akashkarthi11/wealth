-- What each outside provider actually returned, so a response can be inspected without spending another request.
-- Shapes and small samples only: never a secret, never a whole payload. Additive.
CREATE TABLE IF NOT EXISTS wealth_api_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  endpoint text NOT NULL,                 -- query secrets replaced before it is stored
  ticker text,
  http_status integer,
  ok boolean NOT NULL DEFAULT false,
  duration_ms integer,
  bytes integer,
  response_keys text[] NOT NULL DEFAULT '{}',   -- the top-level field names
  data_keys text[] NOT NULL DEFAULT '{}',       -- the field names inside "data"
  section_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(section_counts)='object'),
  sample jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sample)='object'),
  usable boolean,                         -- did it carry what the caller needed?
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_api_audit_recent_idx ON wealth_api_audit(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS wealth_api_audit_ticker_idx ON wealth_api_audit(upper(ticker), created_at DESC);
