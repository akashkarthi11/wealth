-- Job queue. The daily dispatch only puts work on this queue; workers take one item at a time, so no job has to finish inside one 60-second
-- function call and a slow job never blocks the others. Additive: no existing table changes.
CREATE TABLE IF NOT EXISTS wealth_job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES wealth_scheduled_jobs(id) ON DELETE CASCADE,
  job_run_id uuid REFERENCES wealth_scheduled_job_runs(id) ON DELETE CASCADE,
  handler_key text NOT NULL,
  task text NOT NULL DEFAULT 'run',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  priority integer NOT NULL DEFAULT 50,
  min_budget_ms integer NOT NULL DEFAULT 8000,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wealth_job_queue_open_idx ON wealth_job_queue(priority, created_at) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS wealth_job_queue_run_idx ON wealth_job_queue(job_run_id);
CREATE INDEX IF NOT EXISTS wealth_job_queue_job_idx ON wealth_job_queue(job_id) WHERE status IN ('pending','running');
