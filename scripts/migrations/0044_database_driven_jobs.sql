-- Central, database-driven scheduler. Additive: preserves existing job execution history and financial records.
CREATE TABLE IF NOT EXISTS wealth_scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  handler_key text NOT NULL UNIQUE CHECK (handler_key IN ('market-price-refresh','nightly-operations','stock-advisor-auto-research','stock-advisor-data-collection')),
  enabled boolean NOT NULL DEFAULT true,
  schedule_time time NOT NULL,
  schedule_frequency text NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekdays')),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text NOT NULL DEFAULT 'not_run',
  last_error text,
  locked_until timestamptz,
  lock_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_scheduled_jobs_due_idx
  ON wealth_scheduled_jobs(next_run_at) WHERE enabled=true;
CREATE TABLE IF NOT EXISTS wealth_scheduled_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES wealth_scheduled_jobs(id) ON DELETE RESTRICT,
  trigger_type text NOT NULL CHECK (trigger_type IN ('scheduled','manual')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_scheduled_job_runs_recent_idx
  ON wealth_scheduled_job_runs(job_id,created_at DESC);
INSERT INTO wealth_scheduled_jobs
  (job_key,name,description,handler_key,schedule_time,schedule_frequency,timezone,next_run_at)
VALUES
 ('market-price-refresh','Market price refresh','Refresh saved asset and instrument prices and retain price history.','market-price-refresh','04:30','daily','Asia/Kolkata',
  CASE WHEN ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '04:30') AT TIME ZONE 'Asia/Kolkata') > now()
       THEN (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '04:30') AT TIME ZONE 'Asia/Kolkata'
       ELSE (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day' + time '04:30') AT TIME ZONE 'Asia/Kolkata' END),
 ('nightly-operations','Nightly interest and backup','Accrue interest and run the configured encrypted backup.','nightly-operations','01:30','daily','Asia/Kolkata',
  CASE WHEN ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '01:30') AT TIME ZONE 'Asia/Kolkata') > now()
       THEN (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '01:30') AT TIME ZONE 'Asia/Kolkata'
       ELSE (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day' + time '01:30') AT TIME ZONE 'Asia/Kolkata' END),
 ('stock-advisor-auto-research','Stock Advisor auto-research','Check enabled per-user Auto Research schedules and queue due research.','stock-advisor-auto-research','09:45','daily','Asia/Kolkata',
  CASE WHEN ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '09:45') AT TIME ZONE 'Asia/Kolkata') > now()
       THEN (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '09:45') AT TIME ZONE 'Asia/Kolkata'
       ELSE (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day' + time '09:45') AT TIME ZONE 'Asia/Kolkata' END),
 ('stock-advisor-data-collection','Stock Advisor data collection','Collect scheduled instrument and announcement data.','stock-advisor-data-collection','18:30','daily','Asia/Kolkata',
  CASE WHEN ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '18:30') AT TIME ZONE 'Asia/Kolkata') > now()
       THEN (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + time '18:30') AT TIME ZONE 'Asia/Kolkata'
       ELSE (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day' + time '18:30') AT TIME ZONE 'Asia/Kolkata' END)
ON CONFLICT (job_key) DO NOTHING;
