// A research run used to move only while someone had the page open: Production left two BEL runs sitting at
// status=queued, next_step=0 for hours (owner's runs, 2026-11-23). Debate steps now ride the job queue, one step per
// item, so a scheduled run finishes with no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { enqueueDebateStep, adoptStrandedDebates, DEBATE_HANDLER } from '../../api/_lib/job-queue.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

async function seed(a, { status = 'queued', jobStatus = 'pending', stage = 'debate', runAt = null } = {}) {
  const [user] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES($1,'x','admin')
    ON CONFLICT (email) DO UPDATE SET role='admin' RETURNING id`, ['t' + Math.random().toString(36).slice(2) + '@x.test']);
  const [run] = await a.query(`INSERT INTO wealth_stock_advisor_runs(user_id,run_key,status,run_at)
    VALUES($1,$2,$3,COALESCE($4::timestamptz,now())) RETURNING id`, [user.id, 'k' + Math.random().toString(36).slice(2), status, runAt]);
  await a.query(`INSERT INTO wealth_stock_advisor_run_jobs(run_id,stage,status) VALUES($1,$2,$3)`, [run.id, stage, jobStatus]);
  return run.id;
}
const queued = (a, runId) => a.query(`SELECT id,priority,min_budget_ms,status FROM wealth_job_queue
  WHERE handler_key=$1 AND payload->>'run_id'=$2`, [DEBATE_HANDLER, runId]);

test('a step is queued once: a run already waiting on the queue is not queued again', async () => {
  const { a } = await migratedDb();
  const runId = await seed(a);
  assert.equal(await enqueueDebateStep(a, runId), 1);
  assert.equal(await enqueueDebateStep(a, runId), 0, 'one open item per run, so steps never run in parallel');
  const rows = await queued(a, runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priority, 60, 'after the day’s data collection');
  assert.ok(rows[0].min_budget_ms >= 13000, 'a step is only started with room for a model call');

  // once that item is finished the next step may be queued
  await a.query(`UPDATE wealth_job_queue SET status='done',finished_at=now() WHERE id=$1`, [rows[0].id]);
  assert.equal(await enqueueDebateStep(a, runId), 1);
  assert.equal(await enqueueDebateStep(a, null), 0, 'no run id, nothing queued');
});

test('runs left stranded by the browser-driven worker are adopted; finished ones are left alone', async () => {
  const { a } = await migratedDb();
  const stranded = await seed(a, { status: 'queued', runAt: '2026-11-23T05:10:00Z' });   // the real Production case
  const running = await seed(a, { status: 'running' });
  const done = await seed(a, { status: 'completed', jobStatus: 'completed' });
  const failed = await seed(a, { status: 'failed', jobStatus: 'failed' });

  const adopted = await adoptStrandedDebates(a);
  assert.equal(adopted, 2, 'the queued and running runs, not the finished ones');
  assert.equal((await queued(a, stranded)).length, 1);
  assert.equal((await queued(a, running)).length, 1);
  assert.equal((await queued(a, done)).length, 0);
  assert.equal((await queued(a, failed)).length, 0);

  assert.equal(await adoptStrandedDebates(a), 0, 'running it again adopts nothing twice');
});

test('a step that is waiting for the shared model slot keeps its wait when the next item is queued', async () => {
  const { a } = await migratedDb();
  const runId = await seed(a);
  const later = new Date(Date.now() + 25000).toISOString();
  await enqueueDebateStep(a, runId, { availableAt: later });
  const [row] = await a.query(`SELECT available_at FROM wealth_job_queue WHERE payload->>'run_id'=$1`, [runId]);
  assert.ok(new Date(row.available_at).getTime() > Date.now() + 10000, 'it is not offered to a worker before then');
});

test('wiring: the queue runs a debate step, queues the next one only while the run is open, and sweeps stranded runs', () => {
  const q = read('api/_lib/job-queue.js');
  assert.match(q, /item\.handler_key === DEBATE_HANDLER/);
  assert.match(q, /result = await runDebateStep\(runId\)/);
  assert.match(q, /if \(!result\.done\) await enqueueDebateStep\(db, runId, \{ availableAt: result\.available_at \}\)/);
  assert.match(q, /adoptStrandedDebates\(db\)\.catch/, 'the sweeper runs with the rest of the cleanup');

  const d = read('api/_lib/stock-advisor-debate.js');
  assert.match(d, /export async function runDebateStep\(runId\)/);
  assert.match(d, /\['completed','failed','partially_completed'\]\.includes\(String\(run\.status\)\)/, 'a finished run reports done');
  assert.match(d, /CRON_SECRET is not configured/, 'the internal call is authenticated, not anonymous');
});
