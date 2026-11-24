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
  // The provider list (quotas, usage, health) moved into provider-directory.js, shared by API usage and Provider
  // Health (2026-11-24), so the security property lives there now — both pages render it, neither route computes it.
  const route = read('api/_routes/api-usage.js');
  const dir = read('api/_lib/provider-directory.js');
  assert.match(dir, /const set = name => String\(process\.env\[name\] \|\| ''\)\.trim\(\)\.length > 0/, 'presence only');
  // the env var NAME may be shown; its value must never be read into the response
  assert.doesNotMatch(dir, /process\.env\[[^\]]+\]\s*\)?\s*[,}]\s*$/m);
  for (const k of ['AI_GATEWAY_API_KEY', 'GROQ_API_KEY']) assert.ok(dir.includes(k), k + ' is named so it can be set in Vercel');
  assert.match(route, /cannot be changed from the app/);
  // Fincrux is not an env var here: loadFincruxApiKeys (0050/0051) folds the stored per-account keys and the
  // FINCRUX_API_KEY* fallbacks into one list, so the page reports configuration from that list. Every entry in it
  // carries the DECRYPTED key in .value, so this page may read an account's label, source, id and count — nothing else.
  assert.match(dir, /const fincruxLimit = 5 \* activeFincruxAccounts\.length/, 'the quota comes from how many accounts are enabled');
  assert.doesNotMatch(dir, /\.value\b/, 'the decrypted key value is never read into the response');
  assert.doesNotMatch(dir, /\bmasked\b|\blast4\b/, 'not even a masked key or its last four digits belong on this page');
  // Provider Health (stock-advisor.js) now reads the same shared directory, so it must not reintroduce a leak either.
  const advisor = read('api/_routes/stock-advisor.js');
  assert.match(advisor, /buildProviderDirectory\(sql\)/, 'Provider Health reads the same shared directory, not its own copy');
  assert.doesNotMatch(advisor, /\.value\b.*fincrux/i);
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

test('a worker pass that ran is a success, even when a task inside it failed', () => {
  // "Run queue now" reported failure to the admin whenever a single provider task failed, because the route answered
  // 500 and the button's catch showed an error - hiding that the pass had processed its work (2026-11-24).
  const route = read('api/_routes/jobs-worker.js');
  const success = route.match(/const status=[\s\S]*?return json\(res,[^;]*\);/);
  assert.ok(success, 'the success path returns a response');
  assert.match(success[0], /return json\(res,200,/, 'the pass that ran answers 200, not 500');
  assert.match(success[0], /failedTasks\.length\?'failed_tasks'/, 'and says so in the status');
  assert.match(success[0], /failedTasks/, 'the failed tasks are reported in the body for the admin to read');
  // A worker that could not run at all is still a server error.
  assert.match(route, /json\(res,500,\{ok:false/, 'a worker that threw is still a 500');

  const app = read('app.js');
  const start = app.indexOf("const runQueue=e.target.closest('[data-queue-run]')");
  assert.ok(start > 0, 'the button handler is present');
  const button = app.slice(start, start + 900);
  assert.ok(button.includes('failedTasks||[]'), 'the button reads the failed tasks');
  assert.ok(button.includes("' · '+failed+' failed'"), 'and shows how many failed next to how many ran');
});
