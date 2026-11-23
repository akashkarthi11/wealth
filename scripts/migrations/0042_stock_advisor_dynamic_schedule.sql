-- Dynamic per-user Auto Research scheduling. Additive only; no existing reports or financial data are changed.
ALTER TABLE wealth_stock_advisor_settings
  ADD COLUMN IF NOT EXISTS schedule_frequency text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_scheduled_date date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='wealth_stock_advisor_settings_frequency_check'
      AND conrelid='wealth_stock_advisor_settings'::regclass
  ) THEN
    ALTER TABLE wealth_stock_advisor_settings
      ADD CONSTRAINT wealth_stock_advisor_settings_frequency_check
      CHECK (schedule_frequency IN ('daily','weekdays'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  execution_key text NOT NULL,
  run_type text NOT NULL CHECK (run_type IN ('scheduled','manual')),
  scheduled_date date,
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','submitted','completed','partial','failed','skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  tickers_total integer NOT NULL DEFAULT 0 CHECK (tickers_total>=0),
  tickers_submitted integer NOT NULL DEFAULT 0 CHECK (tickers_submitted>=0),
  tickers_failed integer NOT NULL DEFAULT 0 CHECK (tickers_failed>=0),
  result_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result_json)='array'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_schedule_execution_uq UNIQUE(user_id,execution_key)
);

CREATE INDEX IF NOT EXISTS wealth_stock_advisor_schedule_runs_user_recent_idx
  ON wealth_stock_advisor_schedule_runs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_schedule_runs_due_idx
  ON wealth_stock_advisor_schedule_runs(status,scheduled_for)
  WHERE run_type='scheduled';
CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_schedule_manual_active_uq
  ON wealth_stock_advisor_schedule_runs(user_id)
  WHERE run_type='manual' AND status IN ('queued','running');
