-- Encrypted, ordered provider API-key overrides. Environment variables remain the default fallback.
CREATE TABLE IF NOT EXISTS wealth_provider_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  label text NOT NULL DEFAULT 'API key',
  encrypted_key text NOT NULL,
  key_iv text NOT NULL,
  key_tag text NOT NULL,
  key_fingerprint text NOT NULL,
  priority integer NOT NULL DEFAULT 1 CHECK (priority > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, key_fingerprint)
);
CREATE INDEX IF NOT EXISTS wealth_provider_api_keys_order_idx
  ON wealth_provider_api_keys(user_id, provider, enabled, priority);
