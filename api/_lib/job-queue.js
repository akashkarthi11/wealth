import { runCollectionTask, finalizeCollectionRun, TASKS } from './stock-advisor-data-collection.js';
import { runDebateStep } from './stock-advisor-debate.js';

// The job queue. The dispatch only puts work on wealth_job_queue; a worker takes ONE item at a time and runs it, then takes the next while
// time is left in this function call (Vercel stops a call at 60 s). What is not reached stays queued for the next worker call, so a slow or
// big job never has to fit in one call and never blocks the others. A queue item is either a whole job (interest, backup, ...) or, for the
// Stock Advisor data collection, one provider call for one stock.
export const DEBATE_HANDLER = 'stock-advisor-debate';
export const DEBATE_PRIORITY = 60;        // after the day's data collection, before anything optional
const DEBATE_STEP_MS = 16000;             // one free-model call, with headroom
export const DISPATCH_BUDGET_MS = 52000;
export const MIN_START_MS = 1000;
const LOCK_SECONDS = 90;
const STALLED_AFTER = '5 minutes';
export const STALLED_MESSAGE = 'Stopped before it finished (the 60-second function limit was reached). Work done before that point is saved.';
const obj = v => (typeof v === 'string' ? JSON.parse(v) : v) || {};

export async function enqueueItems(db, rows) {
  if (!rows.length) return 0;
  // created_at follows the planned order (one millisecond apart), so items of the same priority run in the order they were planned.
  await db.query(`INSERT INTO wealth_job_queue(job_id,job_run_id,handler_key,task,payload,priority,min_budget_ms,max_attempts,created_at)
    SELECT job_id,job_run_id,handler_key,task,payload,priority,min_budget_ms,max_attempts,now()+seq*interval '1 millisecond'
    FROM jsonb_to_recordset($1::jsonb) AS x(job_id uuid,job_run_id uuid,handler_key text,task text,payload jsonb,priority int,min_budget_ms int,max_attempts int,seq int)`, [JSON.stringify(rows)]);
  return rows.length;
}

export async function queueCounts(db) {
  const rows = await db.query(`SELECT status,count(*)::int AS n FROM wealth_job_queue WHERE status IN ('pending','running') GROUP BY status`);
  const out = { pending: 0, running: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  // Research runs that are open but have nothing queued yet. The worker adopts them, so a page that only watched
  // "pending" would never call the worker and the runs would sit until the next cron.
  const [stranded] = await db.query(`SELECT count(*)::int AS n FROM wealth_stock_advisor_runs r
    JOIN wealth_stock_advisor_run_jobs j ON j.run_id=r.id AND j.stage='debate'
    WHERE r.status NOT IN ('completed','failed','partially_completed') AND j.status IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.handler_key=$1 AND q.payload->>'run_id'=r.id::text AND q.status IN ('pending','running'))`, [DEBATE_HANDLER]);
  out.stranded = Number(stranded?.n || 0);
  out.waiting = out.pending + out.running + out.stranded;
  return out;
}

// Take the next item that fits in the time left. SKIP LOCKED: two workers never take the same item. An item whose worker was cut off
// (its lock ran out) is taken again, until its attempts are used up.
export async function claimNext(db, remainingMs) {
  const rows = await db.query(`WITH claim_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('wealth-job-queue-claim'))
    )
    UPDATE wealth_job_queue q SET status='running',attempts=q.attempts+1,locked_until=now()+interval '${LOCK_SECONDS} seconds',started_at=now(),finished_at=NULL,error=NULL
    WHERE q.id=(SELECT id FROM wealth_job_queue, claim_lock
      WHERE ((status='pending' AND available_at<=now()) OR (status='running' AND locked_until<now())) AND attempts<max_attempts AND min_budget_ms<=$1
      AND NOT (
        task='fincrux' AND EXISTS (
          SELECT 1 FROM wealth_job_queue active_fincrux
          WHERE active_fincrux.task='fincrux' AND active_fincrux.status='running'
        )
      )
      ORDER BY priority,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING q.*`, [Math.floor(remainingMs)]);
  return rows[0] || null;
}

// One queued item = one debate step. The next step is queued only when the run still has one, so a finished or failed
// run stops by itself and nothing loops.
export async function enqueueDebateStep(db, runId, { availableAt = null } = {}) {
  if (!runId) return 0;
  const rows = await db.query(`INSERT INTO wealth_job_queue(handler_key,task,payload,priority,min_budget_ms,max_attempts,available_at)
    SELECT $1,'step',jsonb_build_object('run_id',$2::text),$3,$4,2,COALESCE($5::timestamptz,now())
    WHERE NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.handler_key=$1 AND q.payload->>'run_id'=$2::text AND q.status IN ('pending','running'))
    RETURNING id`, [DEBATE_HANDLER, String(runId), DEBATE_PRIORITY, DEBATE_STEP_MS, availableAt]);
  return rows.length;
}
// Research runs that are still open but have nothing on the queue: the ones the old browser-driven worker left stranded.
export async function adoptStrandedDebates(db, limit = 25) {
  const open = await db.query(`SELECT r.id, j.available_at FROM wealth_stock_advisor_runs r
    JOIN wealth_stock_advisor_run_jobs j ON j.run_id=r.id AND j.stage='debate'
    WHERE r.status NOT IN ('completed','failed','partially_completed')
      AND j.status IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.handler_key=$1 AND q.payload->>'run_id'=r.id::text AND q.status IN ('pending','running'))
    ORDER BY r.run_at LIMIT ${Number(limit) || 25}`, [DEBATE_HANDLER]);
  let adopted = 0;
  for (const row of open) adopted += await enqueueDebateStep(db, row.id, { availableAt: row.available_at });
  return adopted;
}

const mapRunStatus = (http, payload) => {
  if (http >= 400 || payload?.status === 'failed') return 'failed';
  if (payload?.status === 'partial' || payload?.ok === false || payload?.failed > 0 || payload?.instruments?.failed > 0) return 'partial';
  if (payload?.status === 'skipped' || payload?.outcome === 'no_work_due') return 'skipped';
  return 'succeeded';
};

export async function finishJobRun(db, { runId, jobId, status, http = null, payload = {}, error = null }) {
  const done = await db.query(`UPDATE wealth_scheduled_job_runs SET status=$2,finished_at=now(),http_status=$3,result=$4::jsonb,error=$5 WHERE id=$1 AND status='running' RETURNING id`,
    [runId, status, http, JSON.stringify(payload), error]);
  if (!done.length) return null;
  await db.query(`UPDATE wealth_scheduled_jobs j SET last_run_at=now(),last_status=$2,last_error=$3,locked_until=NULL,lock_token=NULL,updated_at=now()
    WHERE j.id=$1 AND NOT EXISTS (SELECT 1 FROM wealth_scheduled_job_runs r WHERE r.job_id=j.id AND r.status='running' AND r.id<>$4)`, [jobId, status, status === 'failed' ? String(error || '').slice(0, 1000) : null, runId]);
  return { status, payload };
}

// The last item of a job run has finished: work out the run's result and close it. Safe to call twice (only a 'running' run changes).
export async function finalizeJobRun(db, runId) {
  const [run] = await db.query(`SELECT r.id,r.job_id,r.status,j.handler_key FROM wealth_scheduled_job_runs r JOIN wealth_scheduled_jobs j ON j.id=r.job_id WHERE r.id=$1`, [runId]);
  if (!run || run.status !== 'running') return null;
  const items = await db.query('SELECT task,status,payload,result,error FROM wealth_job_queue WHERE job_run_id=$1 ORDER BY priority,created_at,id', [runId]);
  const args = { runId, jobId: run.job_id };
  if (!items.length) return finishJobRun(db, { ...args, status: 'failed', payload: { error: STALLED_MESSAGE }, error: STALLED_MESSAGE });
  if (run.handler_key === 'stock-advisor-data-collection') {
    const crid = obj(items[0].payload).collection_run_id;
    await finalizeCollectionRun(db, crid);
    const [c] = crid ? await db.query('SELECT status,summary,error FROM wealth_stock_advisor_data_collection_runs WHERE id=$1', [crid]) : [];
    if (!c) return finishJobRun(db, { ...args, status: 'failed', payload: { error: 'The collection run record is missing.' }, error: 'The collection run record is missing.' });
    if (c.status === 'running') return null;
    const s = obj(c.summary);
    const payload = { ok: c.status === 'succeeded', status: c.status, run_id: crid, instruments: s.instruments, nav_updated: s.nav_updated, market_data_updated: s.market_data_updated, financials_unverified: s.financials_unverified,
      financials_verified: s.financials_verified, announcements: s.announcements, failed: s.failed, skipped: s.skipped, feeds: s.feeds, tasks: items.length };
    return finishJobRun(db, { ...args, status: c.status === 'succeeded' ? 'succeeded' : c.status === 'failed' ? 'failed' : 'partial', http: 200, payload, error: c.status === 'failed' ? JSON.stringify(payload).slice(0, 1500) : null });
  }
  const item = items[0];
  if (item.status === 'failed') return finishJobRun(db, { ...args, status: 'failed', payload: { error: item.error }, error: String(item.error || 'Failed').slice(0, 1500) });
  const r = obj(item.result), http = r.http_status || 200, payload = r.payload || {}, status = mapRunStatus(http, payload);
  return finishJobRun(db, { ...args, status, http, payload, error: status === 'failed' ? JSON.stringify(payload).slice(0, 1500) : null });
}

async function settle(db, jobRunId) {
  if (!jobRunId) return;
  const [open] = await db.query(`SELECT count(*)::int AS n FROM wealth_job_queue WHERE job_run_id=$1 AND status IN ('pending','running')`, [jobRunId]);
  if (!Number(open?.n)) await finalizeJobRun(db, jobRunId);
}

// Run one claimed item and record how it went. A task that throws is tried again (up to max_attempts) after a short wait.
export async function runItem(db, item, { runHandler, deadlineAt }) {
  try {
    let result;
    if (item.handler_key === DEBATE_HANDLER) {
      const runId = obj(item.payload).run_id;
      result = await runDebateStep(runId);
      // Queue the next step unless the run has finished; a step waiting on the shared model slot keeps its wait.
      if (!result.done) await enqueueDebateStep(db, runId, { availableAt: result.available_at });
    }
    else if (item.handler_key === 'stock-advisor-data-collection' && TASKS[item.task]) result = await runCollectionTask(db, item.task, obj(item.payload), { deadlineAt });
    else { const r = await runHandler(item.handler_key, deadlineAt); result = { http_status: r.http_status, payload: r.payload }; }
    const payload = result?.payload || result || {};
    const businessOutcome = String(payload?.status || (payload?.ok === false ? 'partial' : 'succeeded'));
    const executionStatus = ['failed','error'].includes(businessOutcome) ? 'failed' : 'done';
    const outcomeError = executionStatus === 'failed' ? String(payload?.error || payload?.message || 'Provider task failed').slice(0, 500) : null;
    await db.query(`UPDATE wealth_job_queue SET status=$2,result=$3::jsonb,error=$4,finished_at=now(),locked_until=NULL WHERE id=$1`, [item.id, executionStatus, JSON.stringify(result), outcomeError]);
    await settle(db, item.job_run_id);
    return { id: item.id, task: item.task, status: executionStatus, outcome: businessOutcome };
  } catch (e) {
    const message = String(e?.message || e).slice(0, 500);
    if (Number(item.attempts) < Number(item.max_attempts)) {
      await db.query(`UPDATE wealth_job_queue SET status='pending',locked_until=NULL,error=$2,available_at=now()+($3::text||' seconds')::interval WHERE id=$1`, [item.id, message, String(30 * Number(item.attempts))]);
      return { id: item.id, task: item.task, status: 'retry' };
    }
    await db.query(`UPDATE wealth_job_queue SET status='failed',error=$2,finished_at=now(),locked_until=NULL WHERE id=$1`, [item.id, message]);
    await settle(db, item.job_run_id);
    return { id: item.id, task: item.task, status: 'failed' };
  }
}

// Work through the queue until the deadline. Returns what ran and what is still waiting.
export async function drainQueue({ db, runHandler, deadlineAt = Date.now() + DISPATCH_BUDGET_MS }) {
  const ran = [];
  for (;;) {
    const remaining = deadlineAt - Date.now();
    if (remaining < MIN_START_MS) break;
    const item = await claimNext(db, remaining);
    if (!item) break;
    ran.push(await runItem(db, item, { runHandler, deadlineAt }));
  }
  return { processed: ran.length, items: ran.map(x => x.task + ':' + x.status + (x.outcome ? ':' + x.outcome : '')), outcomes: ran.map(x => ({ task: x.task, execution: x.status, outcome: x.outcome || null })), queue: await queueCounts(db) };
}

// Clean up after calls that were cut off: items out of attempts are failed, runs with nothing left to do are closed (a run with no items at
// all and older than five minutes was cut off before it queued anything), collection runs without queue items are failed, old finished items go.
export async function reapStalled(db) {
  const failedItems = await db.query(`UPDATE wealth_job_queue SET status='failed',finished_at=now(),locked_until=NULL,error=$1
    WHERE status='running' AND locked_until<now() AND attempts>=max_attempts RETURNING job_run_id`, [STALLED_MESSAGE]);
  for (const id of new Set(failedItems.map(r => r.job_run_id).filter(Boolean))) await settle(db, id); // close the runs those items belonged to
  const stale = await db.query(`SELECT r.id FROM wealth_scheduled_job_runs r WHERE r.status='running' AND r.started_at<now()-interval '${STALLED_AFTER}'
    AND NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.job_run_id=r.id AND q.status IN ('pending','running'))`);
  let closed = 0;
  for (const r of stale) if (await finalizeJobRun(db, r.id)) closed++;
  const collections = await db.query(`UPDATE wealth_stock_advisor_data_collection_runs c SET status='failed',finished_at=now(),error=$1
    WHERE c.status='running' AND c.started_at<now()-interval '${STALLED_AFTER}'
      AND NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.payload->>'collection_run_id'=c.id::text) RETURNING c.id`, [STALLED_MESSAGE]);
  await db.query(`DELETE FROM wealth_job_queue WHERE status IN ('done','failed') AND finished_at<now()-interval '30 days'`);
  const adopted = await adoptStrandedDebates(db).catch(() => 0);
  return { items_failed: failedItems.length, job_runs: closed, collection_runs: collections.length, debates_adopted: adopted };
}
