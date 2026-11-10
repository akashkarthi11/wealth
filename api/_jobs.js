// Job run records (TSD Claude Plan 2, Phase G). Recording never breaks the job: if the table is missing
// (database without migration 0007) or the write fails, the job still runs and returns its result.
import { sql } from './_lib.js';

export async function startJob(job, db = sql) {
  try { return (await db.query(`INSERT INTO wealth_job_runs (job) VALUES ($1) RETURNING id`, [job]))[0].id; }
  catch (e) { console.warn('[wealth-jobs:start]', job, e?.message || e); return null; }
}

export async function finishJob(id, status, summary = {}, db = sql) {
  if (!id) return;
  try { await db.query(`UPDATE wealth_job_runs SET finished_at = now(), status = $2, summary = $3::jsonb WHERE id = $1`, [id, status, JSON.stringify(summary)]); }
  catch (e) { console.warn('[wealth-jobs:finish]', id, e?.message || e); }
}

// Last run per job, plus the latest activity of work done outside the app (agents writing tables directly).
export async function jobActivity(db = sql) {
  const runs = await db.query(`SELECT DISTINCT ON (job) job, started_at, finished_at, status, summary
    FROM wealth_job_runs ORDER BY job, started_at DESC`).catch(() => []);
  const failing = await db.query(`SELECT job, count(*)::int AS n FROM (
      SELECT job, status, row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS k FROM wealth_job_runs) x
    WHERE k <= 2 AND status = 'failed' GROUP BY job HAVING count(*) = 2`).catch(() => []);
  const [ext] = await db.query(`SELECT
      (SELECT max(run_at) FROM wealth_stock_advisor_reports) AS advisor_last,
      (SELECT max(created_at) FROM wealth_email_imports) AS gmail_last,
      (SELECT max(accrual_date)::text FROM wealth_interest_ledger) AS interest_last_date,
      (SELECT max(fetched_at) FROM wealth_instrument_prices) AS prices_last`).catch(() => [{}]);
  return { runs, failingTwice: failing.map(f => f.job), external: ext || {} };
}
