-- Independent Stock Advisor data collection. Separate from advisor runs and reports.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_data_collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary)='object'),
  error text
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_data_collection_runs_recent_idx
  ON wealth_stock_advisor_data_collection_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES wealth_stock_advisor_data_collection_runs(id) ON DELETE SET NULL,
  instrument_id uuid REFERENCES wealth_instruments(id) ON DELETE SET NULL,
  ticker text NOT NULL,
  asset_type text NOT NULL,
  source_type text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  publisher text,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  excerpt text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified','stale','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_data_source_url_check CHECK (url ~ '^https?://'),
  UNIQUE (ticker,url)
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_data_sources_ticker_recent_idx
  ON wealth_stock_advisor_data_sources(ticker,retrieved_at DESC);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_data_sources_type_recent_idx
  ON wealth_stock_advisor_data_sources(source_type,published_at DESC);
