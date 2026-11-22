-- Structured Bull/Bear investment cases for each stock discussed in a Stock Advisor run.
-- One row per run, stock, side and agent; full evidence is retained for review and comparison.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_bull_bear_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  stock_name text NOT NULL,
  exchange text NOT NULL DEFAULT 'NSE',
  side text NOT NULL,
  agent_key text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  thesis text NOT NULL,
  key_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  fundamental_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  technical_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  valuation jsonb NOT NULL DEFAULT '{}'::jsonb,
  catalysts jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(5,2),
  target_price numeric(18,4),
  time_horizon text,
  verdict text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_bull_bear_side_check CHECK (side IN ('bull','bear')),
  CONSTRAINT wealth_stock_advisor_bull_bear_ticker_check CHECK (length(trim(ticker)) BETWEEN 1 AND 30),
  CONSTRAINT wealth_stock_advisor_bull_bear_name_check CHECK (length(trim(stock_name)) BETWEEN 1 AND 160),
  CONSTRAINT wealth_stock_advisor_bull_bear_thesis_check CHECK (length(trim(thesis)) BETWEEN 1 AND 30000),
  CONSTRAINT wealth_stock_advisor_bull_bear_confidence_check CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  CONSTRAINT wealth_stock_advisor_bull_bear_target_check CHECK (target_price IS NULL OR target_price >= 0),
  CONSTRAINT wealth_stock_advisor_bull_bear_json_check CHECK (
    jsonb_typeof(key_points)='array' AND
    jsonb_typeof(fundamental_evidence)='object' AND
    jsonb_typeof(technical_evidence)='object' AND
    jsonb_typeof(valuation)='object' AND
    jsonb_typeof(catalysts)='array' AND
    jsonb_typeof(risks)='array' AND
    jsonb_typeof(sources)='array'
  ),
  CONSTRAINT wealth_stock_advisor_bull_bear_run_stock_side_agent_key
    UNIQUE (run_id, ticker, side, agent_key)
);

CREATE INDEX IF NOT EXISTS wealth_stock_advisor_bull_bear_run_created_idx
  ON wealth_stock_advisor_bull_bear_cases(run_id, created_at DESC);
