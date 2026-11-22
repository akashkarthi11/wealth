-- Per-user Free AI Auto Research preferences. This stores settings only; no orders or portfolio writes.
CREATE TABLE IF NOT EXISTS wealth_stock_advisor_settings (
  user_id uuid PRIMARY KEY REFERENCES wealth_users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'all' CHECK (mode IN ('all','manual')),
  selected_tickers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_tickers)='array'),
  schedule_timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  schedule_time text NOT NULL DEFAULT '09:48',
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_status text NOT NULL DEFAULT 'not_configured',
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_stock_advisor_settings_schedule_time_check CHECK (schedule_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
