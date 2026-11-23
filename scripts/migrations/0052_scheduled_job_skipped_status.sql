-- A scheduler check that finds no due Auto Research work is a valid skipped run, not a completed research run.
-- Keep the execution result distinct from successful research completion.
ALTER TABLE wealth_scheduled_job_runs
  DROP CONSTRAINT IF EXISTS wealth_scheduled_job_runs_status_check;
ALTER TABLE wealth_scheduled_job_runs
  ADD CONSTRAINT wealth_scheduled_job_runs_status_check
  CHECK (status IN ('running','succeeded','partial','failed','skipped'));
