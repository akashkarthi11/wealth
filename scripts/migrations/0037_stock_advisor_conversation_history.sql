-- Stock Advisor: durable agent runs and message-by-message conversation history.
-- Additive only: existing reports remain available and are linked only when new runs arrive.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  run_key text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'completed',
  agent_count integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_runs_status_check CHECK (status IN ('running','completed','failed')),
  CONSTRAINT wealth_stock_advisor_runs_agent_count_check CHECK (agent_count BETWEEN 1 AND 12),
  CONSTRAINT wealth_stock_advisor_runs_user_run_key_key UNIQUE (user_id, run_key)
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_runs_user_run_idx
  ON wealth_stock_advisor_runs(user_id, run_at DESC);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES wealth_stock_advisor_runs(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL,
  round_no integer NOT NULL DEFAULT 1,
  speaker text NOT NULL,
  agent_key text NOT NULL DEFAULT '',
  message_type text NOT NULL DEFAULT 'message',
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_messages_sequence_check CHECK (sequence_no >= 0),
  CONSTRAINT wealth_stock_advisor_messages_content_check CHECK (length(content) BETWEEN 1 AND 30000),
  CONSTRAINT wealth_stock_advisor_messages_run_sequence_key UNIQUE (run_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_messages_run_order_idx
  ON wealth_stock_advisor_messages(run_id, sequence_no);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(),
  report_text text NOT NULL DEFAULT '',
  report_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
\nALTER TABLE wealth_stock_advisor_reports
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES wealth_stock_advisor_runs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_reports_run_id_uidx
  ON wealth_stock_advisor_reports(run_id) WHERE run_id IS NOT NULL;
