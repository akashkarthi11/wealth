-- Additive evidence, orchestration and evaluation storage for the hybrid Stock Advisor.
-- Existing runs/reports/messages/cases remain the user-facing history source.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  source_type text NOT NULL DEFAULT 'web',
  title text NOT NULL,
  url text NOT NULL,
  publisher text,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  excerpt text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified','unverified','stale','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_source_url_check CHECK (url ~ '^https?://'),
  CONSTRAINT wealth_stock_advisor_source_evidence_check CHECK (jsonb_typeof(evidence)='object'),
  UNIQUE (run_id, ticker, url)
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_sources_run_ticker_idx
  ON wealth_stock_advisor_research_sources(run_id, ticker, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_agent_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  agent_key text NOT NULL,
  stage text NOT NULL,
  round_no integer NOT NULL DEFAULT 1 CHECK (round_no > 0),
  provider text,
  model text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','running','completed','failed','skipped')),
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_hash text,
  prompt_tokens integer,
  completion_tokens integer,
  estimated_cost_usd numeric(14,6),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_agent_output_json_check CHECK (jsonb_typeof(output)='object')
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_agent_outputs_run_idx
  ON wealth_stock_advisor_agent_outputs(run_id, ticker, stage, round_no);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, stage)
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_jobs_ready_idx
  ON wealth_stock_advisor_run_jobs(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  action text NOT NULL CHECK (action IN ('BUY','HOLD','SELL','NO_ACTION')),
  as_of timestamptz NOT NULL DEFAULT now(),
  reference_price numeric(18,4),
  target_price numeric(18,4),
  horizon_days integer NOT NULL CHECK (horizon_days BETWEEN 1 AND 1095),
  benchmark text NOT NULL DEFAULT 'NIFTY50',
  thesis_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL REFERENCES wealth_stock_advisor_predictions(id) ON DELETE CASCADE,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  observed_price numeric(18,4),
  benchmark_return_pct numeric(12,4),
  stock_return_pct numeric(12,4),
  excess_return_pct numeric(12,4),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','outperformed','underperformed','in_line','invalid')),
  notes text
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_evaluations_prediction_idx
  ON wealth_stock_advisor_evaluations(prediction_id, evaluated_at DESC);
