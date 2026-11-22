-- Persistent, resumable four-round Stock Advisor debate.
-- Additive only: original message content and all historical reports/runs are retained.
ALTER TABLE wealth_stock_advisor_runs
  ADD COLUMN IF NOT EXISTS ticker text,
  ADD COLUMN IF NOT EXISTS stock_name text,
  ADD COLUMN IF NOT EXISTS asset_type text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS next_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_steps integer NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS last_completed_round integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_completed_speaker text,
  ADD COLUMN IF NOT EXISTS progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE wealth_stock_advisor_runs
  ALTER COLUMN agent_count SET DEFAULT 9;
ALTER TABLE wealth_stock_advisor_runs
  DROP CONSTRAINT IF EXISTS wealth_stock_advisor_runs_status_check;
ALTER TABLE wealth_stock_advisor_runs
  ADD CONSTRAINT wealth_stock_advisor_runs_status_check
  CHECK (status IN ('queued','running','partially_completed','completed','failed'));

CREATE INDEX IF NOT EXISTS wealth_stock_advisor_runs_user_ticker_idx
  ON wealth_stock_advisor_runs(user_id,ticker,run_at DESC);

ALTER TABLE wealth_stock_advisor_messages
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ticker text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asset_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Historical messages keep their original content; the summary is an extractive preview only.
UPDATE wealth_stock_advisor_messages
SET summary=left(regexp_replace(content,'\s+',' ','g'),700)
WHERE summary='' AND length(content)>0;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_messages_run_idempotency_uq
  ON wealth_stock_advisor_messages(run_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE wealth_stock_advisor_run_jobs
  ADD COLUMN IF NOT EXISTS step_no integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS step_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lease_owner text;

CREATE INDEX IF NOT EXISTS wealth_stock_advisor_jobs_debate_ready_idx
  ON wealth_stock_advisor_run_jobs(status,available_at,locked_at)
  WHERE stage='debate';

CREATE INDEX IF NOT EXISTS wealth_stock_advisor_messages_run_ticker_round_idx
  ON wealth_stock_advisor_messages(run_id,ticker,round_no,sequence_no);

