-- 0007: job observability (TSD Claude Plan 2, Phase G) and data-quality acceptances (Claude Plan 3, Phase 4).
-- Additive only. Rows in both tables are kept (one small row per job run / per accepted issue).

CREATE TABLE IF NOT EXISTS wealth_job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT wealth_job_runs_status_check CHECK (status IN ('running', 'succeeded', 'partial', 'failed'))
);
CREATE INDEX IF NOT EXISTS wealth_job_runs_job_time_idx ON wealth_job_runs (job, started_at DESC);

-- The owner can accept a known data-quality issue (with a reason) so it stops being reported as open.
CREATE TABLE IF NOT EXISTS wealth_data_quality_acceptances (
  user_id     uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  issue_id    text NOT NULL,
  reason      text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_id),
  CONSTRAINT wealth_dq_reason_check CHECK (length(trim(reason)) BETWEEN 3 AND 500)
);
