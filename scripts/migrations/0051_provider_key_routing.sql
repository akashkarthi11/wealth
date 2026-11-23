-- Per-key request identity and explicit ticker routing for Fincrux.
ALTER TABLE wealth_provider_api_keys
  ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT 'WealthPersonalStockResearch/1.0',
  ADD COLUMN IF NOT EXISTS assigned_tickers text[] NOT NULL DEFAULT '{}';

ALTER TABLE wealth_provider_api_keys
  ADD CONSTRAINT wealth_provider_api_keys_user_agent_length
  CHECK (char_length(user_agent) BETWEEN 1 AND 200);

ALTER TABLE wealth_provider_api_keys
  ADD CONSTRAINT wealth_provider_api_keys_assigned_tickers_limit
  CHECK (cardinality(assigned_tickers) <= 100);
