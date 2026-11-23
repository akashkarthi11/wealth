// Production deadlock, 2026-11-23: 17 research runs sat at next_step=0 because the pages only called the worker when
// items were already queued, while the sweeper that creates those items runs only inside the worker. The counts now
// include runs waiting to be adopted, and the admin has a button rather than waiting for the next cron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { queueCounts, enqueueDebateStep, claimNext, runItem, DEBATE_HANDLER } from '../../api/_lib/job-queue.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

async function openRun(a, status = 'queued') {
  const [user] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES($1,'x','admin') RETURNING id`,
    ['u' + Math.random().toString(36).slice(2) + '@x.test']);
  const [run] = await a.query(`INSERT INTO wealth_stock_advisor_runs(user_id,run_key,status) VALUES($1,$2,$3) RETURNING id`,
    [user.id, 'k' + Math.random().toString(36).slice(2), status]);
  await a.query(`INSERT INTO wealth_stock_advisor_run_jobs(run_id,stage,status) VALUES($1,'debate','pending')`, [run.id]);
  return run.id;
}

test('a research run with nothing queued counts as waiting, so a watching page knows to call the worker', async () => {
  const { a } = await migratedDb();
  assert.deepEqual(await queueCounts(a), { pending: 0, running: 0, stranded: 0, waiting: 0 });

  const runId = await openRun(a);
  const stranded = await queueCounts(a);
  assert.equal(stranded.pending, 0, 'nothing is on the queue yet — this is the deadlock');
  assert.equal(stranded.stranded, 1);
  assert.equal(stranded.waiting, 1, 'the page pumps on "waiting", so it no longer sits idle');

  // once its step is queued it is pending, not stranded, and must not be counted twice
  await enqueueDebateStep(a, runId);
  const queued = await queueCounts(a);
  assert.deepEqual([queued.pending, queued.stranded, queued.waiting], [1, 0, 1]);
});

test('a finished run is never counted as waiting', async () => {
  const { a } = await migratedDb();
  const runId = await openRun(a, 'completed');
  await a.query(`UPDATE wealth_stock_advisor_run_jobs SET status='completed' WHERE run_id=$1`, [runId]);
  assert.equal((await queueCounts(a)).waiting, 0);
});

test('wiring: the pages watch "waiting" and give the admin a button that runs the queue now', () => {
  const app = read('app.js');
  assert.match(app, /if\(jobs\.queue\?\.waiting>0\)pumpJobQueue\('jobs',loadJobs\)/);
  assert.match(app, /if\(d\.queue\?\.waiting>0\)pumpJobQueue\('ai-data',loadAiData\)/);
  assert.doesNotMatch(app, /queue\?\.pending>0\)pumpJobQueue/, 'watching only "pending" is what caused the deadlock');
  assert.ok((app.match(/data-queue-run/g) || []).length >= 3, 'a button on both pages, plus its handler');
  assert.match(app, /api\('\/api\/jobs\/worker',\{method:'POST'/);
  assert.match(read('api/_routes/jobs-worker.js'), /reapStalled/, 'the worker adopts stranded runs when it runs');
});

test('provider health sits with the usage, and no key value is ever exposed', () => {
  const route = read('api/_routes/api-usage.js');
  assert.match(route, /const set = name => String\(process\.env\[name\] \|\| ''\)\.trim\(\)\.length > 0/, 'presence only');
  // the env var NAME may be shown; its value must never be read into the response
  assert.doesNotMatch(route, /process\.env\[[^\]]+\]\s*\)?\s*[,}]\s*$/m);
  for (const k of ['FINCRUX_API_KEY', 'AI_GATEWAY_API_KEY', 'GROQ_API_KEY']) assert.ok(route.includes(k), k + ' is named so it can be set in Vercel');
  assert.match(route, /cannot be changed from the app/);
  const app = read('app.js');
  assert.match(app, /Needs a key/);
  assert.match(app, /function auHealth\(p\)/);
});


test('queue execution success does not erase a partial or failed provider outcome',async()=>{
  const updates=[];
  const db={query:async(sql,params)=>{updates.push({sql:String(sql),params});return [];}};
  const item={id:'queue-1',handler_key:'test-handler',task:'test',attempts:1,max_attempts:1,job_run_id:null};
  const partial=await runItem(db,item,{runHandler:async()=>({http_status:200,payload:{ok:false,status:'partial',failed:1}}),deadlineAt:Date.now()+1000});
  assert.deepEqual([partial.status,partial.outcome],['done','partial']);
  assert.equal(updates.at(-1).params[1],'done');
  const failed=await runItem(db,{...item,id:'queue-2'},{runHandler:async()=>({http_status:200,payload:{status:'failed',error:'provider rate limited'}}),deadlineAt:Date.now()+1000});
  assert.deepEqual([failed.status,failed.outcome],['failed','failed']);
  assert.equal(updates.at(-1).params[1],'failed');
  assert.equal(updates.at(-1).params[3],'provider rate limited');
});

test('claimNext executes its SQL successfully when the queue is empty', async () => {
  const { a } = await migratedDb();
  assert.equal(await claimNext(a, 10000), null);
});
