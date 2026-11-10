-- Stock Advisor report history. Additive migration; existing wealth records are untouched.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(),
  report_text text NOT NULL DEFAULT '',
  report_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_reports_user_run_idx
  ON wealth_stock_advisor_reports(user_id, run_at DESC);