// AI data page (admin): the data collection job records every provider call with its time, and a read-only admin route shows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { runStockAdvisorDataCollection } from '../../api/_lib/stock-advisor-data-collection.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('each provider call of the job is timed, and the steps are saved while the run is still going', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.FINCRUX_API_KEY;
  delete process.env.FINCRUX_API_KEY;
  globalThis.fetch = async () => { throw new Error('network blocked in test'); };
  const writes = [];
  const db = { query: async (sql, params = []) => {
    if (/INSERT INTO wealth_stock_advisor_data_collection_runs/.test(sql)) return [{ id: 'run-1' }];
    if (/FROM wealth_instruments/.test(sql)) return [{ id: 'i1', asset_class: 'indian_equity', symbol: 'TCS', name: 'Tata Consultancy Services', price_source_symbol: 'TCS' }];
    if (/UPDATE wealth_stock_advisor_data_collection_runs/.test(sql)) writes.push({ sql, params });
    return [];
  } };
  try {
    const r = await runStockAdvisorDataCollection(db);
    const names = r.steps.map(s => s.provider + (s.ticker ? ':' + s.ticker : ''));
    assert.deepEqual(names, ['NSE RSS', 'NSE RSS', 'NSE RSS', 'NSE RSS', 'NSE RSS', 'NSE RSS', 'TejHQ:TCS', 'NSE XBRL:TCS', 'Yahoo Finance fundamentals:TCS', 'Fincrux'],
      'one step per NSE feed, so no single step has to download all six');
    assert.deepEqual(r.steps.filter(s => s.provider === 'NSE RSS').map(s => s.name.split(' · ')[0]),
      ['Announcements', 'Financial results', 'Annual reports', 'Board meetings', 'Shareholding patterns', 'Corporate actions']);
    for (const s of r.steps) { assert.ok(s.started_at, s.provider + ' has a start time'); assert.equal(typeof s.ms, 'number', s.provider + ' has a duration'); assert.notEqual(s.status, 'running'); }
    const fx = r.steps.find(s => s.provider === 'Fincrux');
    assert.equal(fx.status, 'skipped');
    assert.match(fx.note, /No Fincrux API keys are configured/);
    const nse = r.steps.find(s => s.provider === 'NSE RSS');
    assert.match(nse.note, /Announcements: network blocked in test/, 'feed errors are written out, not shown as [object Object]');
    assert.doesNotMatch(nse.note, /\[object Object\]/);
    assert.equal(typeof r.duration_ms, 'number');
    const progress = writes.filter(w => /jsonb_build_object\('steps'/.test(w.sql));
    assert.ok(progress.length >= 2 * 3, 'progress is written when a call starts and when it ends');
    const last = writes[writes.length - 1];
    assert.match(last.sql, /finished_at=now\(\)/);
    assert.equal(JSON.parse(last.params[2]).steps.length, 10, 'the final summary keeps the steps');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) process.env.FINCRUX_API_KEY = originalKey;
  }
});

function fakeDb(instruments, lastRows = []) {
  const writes = [];
  return { writes, query: async (sql, params = []) => {
    if (/INSERT INTO wealth_stock_advisor_data_collection_runs/.test(sql)) return [{ id: 'run-1' }];
    if (/FROM wealth_instruments/.test(sql)) return instruments;
    if (/max\(retrieved_at\) AS at/.test(sql)) return lastRows;
    if (/UPDATE wealth_stock_advisor_data_collection_runs/.test(sql)) writes.push({ sql, params });
    return [];
  } };
}
const eq = (symbol) => ({ id: symbol, asset_class: 'indian_equity', symbol, name: symbol + ' Limited', price_source_symbol: symbol });

test('the job stops starting provider calls when too little of the 60 seconds is left, says so, and finishes the run', async () => {
  const originalFetch = globalThis.fetch, key = process.env.FINCRUX_API_KEY;
  delete process.env.FINCRUX_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network blocked in test'); };
  try {
    const db = fakeDb([eq('TCS'), eq('INFY')]);
    const r = await runStockAdvisorDataCollection(db, { deadlineAt: Date.now() + 5000 });
    assert.equal(calls, 0, 'no provider was called with 5 seconds left');
    const tej = r.steps.filter(s => s.provider === 'TejHQ');
    assert.deepEqual(tej.map(s => s.status), ['skipped', 'skipped']);
    assert.match(tej[0].note, /Time limit reached/);
    assert.equal(r.skipped_for_time, 6, 'two TejHQ, two NSE XBRL and two Yahoo holding calls are deferred');
    assert.equal(r.status, 'failed', 'nothing was collected, so the run is not reported as a success');
    assert.match(db.writes[db.writes.length - 1].sql, /finished_at=now\(\)/, 'the run still records its finish');
  } finally { globalThis.fetch = originalFetch; if (key !== undefined) process.env.FINCRUX_API_KEY = key; }
});

test('stocks collected longest ago go first, so a run that runs out of time never starves the same stocks', async () => {
  const originalFetch = globalThis.fetch, key = process.env.FINCRUX_API_KEY;
  delete process.env.FINCRUX_API_KEY;
  globalThis.fetch = async () => { throw new Error('network blocked in test'); };
  try {
    const db = fakeDb([eq('AAA'), eq('BBB'), eq('CCC')], [{ ticker: 'AAA', at: '2026-11-23T10:00:00Z' }, { ticker: 'CCC', at: '2026-11-20T10:00:00Z' }]);
    const r = await runStockAdvisorDataCollection(db, {});
    assert.deepEqual(r.steps.filter(s => s.provider === 'TejHQ').map(s => s.ticker), ['BBB', 'CCC', 'AAA'], 'never collected first, then oldest, newest last');
  } finally { globalThis.fetch = originalFetch; if (key !== undefined) process.env.FINCRUX_API_KEY = key; }
});

// ---- the job queue: the dispatch only queues; workers take one item at a time ----
async function jobRow(a, handlerKey) {
  return (await a.query('SELECT * FROM wealth_scheduled_jobs WHERE handler_key=$1', [handlerKey]))[0];
}
async function newRun(a, job) {
  return (await a.query(`INSERT INTO wealth_scheduled_job_runs(job_id,trigger_type,status) VALUES($1,'manual','running') RETURNING id`, [job.id]))[0].id;
}
const item = (job, runId, over = {}) => ({ job_id: job.id, job_run_id: runId, handler_key: job.handler_key, task: 'run', payload: {}, priority: 50, min_budget_ms: 1000, max_attempts: 1, seq: 0, ...over });

test('items come off the queue by priority then planned order, only when they fit in the time left, and are never handed out twice', async () => {
  const { enqueueItems, claimNext } = await import('../../api/_lib/job-queue.js');
  const { a } = await migratedDb();
  const job = await jobRow(a, 'interest-accrual'), runId = await newRun(a, job);
  await enqueueItems(a, [
    item(job, runId, { task: 'c', priority: 50, seq: 0 }),
    item(job, runId, { task: 'b2', priority: 10, seq: 2 }),
    item(job, runId, { task: 'b1', priority: 10, seq: 1 }),
    item(job, runId, { task: 'big', priority: 5, min_budget_ms: 30000, seq: 3 }),
  ]);
  assert.equal((await claimNext(a, 20000)).task, 'b1', 'priority first, then the planned order; the big item does not fit in 20 s');
  assert.equal((await claimNext(a, 20000)).task, 'b2');
  assert.equal((await claimNext(a, 20000)).task, 'c');
  assert.equal(await claimNext(a, 20000), null, 'nothing left that fits, and the claimed items are not offered again');
  assert.equal((await claimNext(a, 40000)).task, 'big', 'with enough time the big item is taken');
});

test('draining runs whole jobs one at a time, closes each job run with the right status, and leaves the rest queued when time is short', async () => {
  const { enqueueItems, drainQueue } = await import('../../api/_lib/job-queue.js');
  const { a } = await migratedDb();
  const interest = await jobRow(a, 'interest-accrual'), backup = await jobRow(a, 'backup'), prices = await jobRow(a, 'market-price-refresh');
  const [r1, r2, r3] = [await newRun(a, interest), await newRun(a, backup), await newRun(a, prices)];
  await enqueueItems(a, [item(interest, r1, { priority: 10 }), item(backup, r2, { priority: 20 }), item(prices, r3, { priority: 30 })]);
  const order = [];
  const runHandler = async key => {
    order.push(key);
    if (key === 'backup') return { http_status: 200, payload: { ok: false, status: 'partial' } };
    if (key === 'market-price-refresh') return { http_status: 500, payload: { error: 'boom' } };
    return { http_status: 200, payload: { ok: true } };
  };
  const out = await drainQueue({ db: a, runHandler, deadlineAt: Date.now() + 20000 });
  assert.deepEqual(order, ['interest-accrual', 'backup', 'market-price-refresh']);
  assert.equal(out.processed, 3);
  assert.deepEqual([out.queue.pending, out.queue.running, out.queue.waiting], [0, 0, 0], 'nothing left, and nothing waiting to be adopted');
  const status = async id => (await a.query('SELECT status,finished_at FROM wealth_scheduled_job_runs WHERE id=$1', [id]))[0];
  assert.equal((await status(r1)).status, 'succeeded');
  assert.equal((await status(r2)).status, 'partial');
  assert.equal((await status(r3)).status, 'failed');
  assert.equal((await jobRow(a, 'market-price-refresh')).last_status, 'failed');
  // no time left: nothing is started, the item stays queued
  const r4 = await newRun(a, interest);
  await enqueueItems(a, [item(interest, r4, { priority: 10 })]);
  const none = await drainQueue({ db: a, runHandler, deadlineAt: Date.now() + 200 });
  assert.equal(none.processed, 0);
  assert.equal(none.queue.pending, 1);
});

test('a failing item is tried again after a wait and then fails the job run; an item cut off with no attempts left is failed and its run closed', async () => {
  const { enqueueItems, drainQueue, reapStalled } = await import('../../api/_lib/job-queue.js');
  const { a } = await migratedDb();
  const job = await jobRow(a, 'backup'), runId = await newRun(a, job);
  await enqueueItems(a, [item(job, runId, { max_attempts: 2 })]);
  let calls = 0;
  const runHandler = async () => { calls++; throw new Error('network down'); };
  let out = await drainQueue({ db: a, runHandler, deadlineAt: Date.now() + 20000 });
  assert.deepEqual([calls, out.items], [1, ['run:retry']], 'first failure: waits before the next try');
  assert.equal((await a.query('SELECT status FROM wealth_scheduled_job_runs WHERE id=$1', [runId]))[0].status, 'running', 'the run is still open while a retry is due');
  await a.query(`UPDATE wealth_job_queue SET available_at=now() WHERE job_run_id=$1`, [runId]);
  out = await drainQueue({ db: a, runHandler, deadlineAt: Date.now() + 20000 });
  assert.deepEqual([calls, out.items], [2, ['run:failed']]);
  const run = (await a.query('SELECT status,error FROM wealth_scheduled_job_runs WHERE id=$1', [runId]))[0];
  assert.equal(run.status, 'failed'); assert.match(run.error, /network down/);

  const job2 = await jobRow(a, 'interest-accrual'), run2 = await newRun(a, job2);
  await enqueueItems(a, [item(job2, run2)]);
  await a.query(`UPDATE wealth_job_queue SET status='running',attempts=1,locked_until=now()-interval '1 minute' WHERE job_run_id=$1`, [run2]);
  const reaped = await reapStalled(a);
  assert.equal(reaped.items_failed, 1);
  const r2 = (await a.query('SELECT status,error FROM wealth_scheduled_job_runs WHERE id=$1', [run2]))[0];
  assert.equal(r2.status, 'failed'); assert.match(r2.error, /60-second function limit/);
});

test('runs cut off by the function limit are marked failed and freed; recent running ones, and runs still waiting on the queue, are left alone', async () => {
  const { reapStalled, enqueueItems } = await import('../../api/_lib/job-queue.js');
  const { a } = await migratedDb();
  const job = await jobRow(a, 'stock-advisor-data-collection');
  await a.query(`UPDATE wealth_scheduled_jobs SET locked_until=now()+interval '10 minutes', lock_token=gen_random_uuid(), last_status='succeeded' WHERE id=$1`, [job.id]);
  const [old] = await a.query(`INSERT INTO wealth_scheduled_job_runs(job_id,trigger_type,status,started_at) VALUES($1,'scheduled','running',now()-interval '20 minutes') RETURNING id`, [job.id]);
  const [oldC] = await a.query(`INSERT INTO wealth_stock_advisor_data_collection_runs(status,started_at) VALUES('running',now()-interval '20 minutes') RETURNING id`);
  const [freshC] = await a.query(`INSERT INTO wealth_stock_advisor_data_collection_runs(status) VALUES('running') RETURNING id`);
  const waiting = await jobRow(a, 'backup');
  const [waitRun] = await a.query(`INSERT INTO wealth_scheduled_job_runs(job_id,trigger_type,status,started_at) VALUES($1,'scheduled','running',now()-interval '2 days') RETURNING id`, [waiting.id]);
  await enqueueItems(a, [item(waiting, waitRun.id)]);
  const r = await reapStalled(a);
  assert.deepEqual([r.job_runs, r.collection_runs], [1, 1]);
  const [run] = await a.query('SELECT status,finished_at,error FROM wealth_scheduled_job_runs WHERE id=$1', [old.id]);
  assert.equal(run.status, 'failed'); assert.ok(run.finished_at); assert.match(run.error, /60-second function limit/);
  const [j] = await a.query('SELECT last_status,locked_until FROM wealth_scheduled_jobs WHERE id=$1', [job.id]);
  assert.equal(j.last_status, 'failed'); assert.equal(j.locked_until, null);
  assert.equal((await a.query('SELECT status FROM wealth_stock_advisor_data_collection_runs WHERE id=$1', [oldC.id]))[0].status, 'failed');
  assert.equal((await a.query('SELECT status FROM wealth_stock_advisor_data_collection_runs WHERE id=$1', [freshC.id]))[0].status, 'running', 'a run started just now is not touched');
  assert.equal((await a.query('SELECT status FROM wealth_scheduled_job_runs WHERE id=$1', [waitRun.id]))[0].status, 'running', 'a run whose work is still queued is waiting, not stalled');
});

test('the data collection is queued as one item per provider call; when the last one finishes the run gets its steps, counts and status', async () => {
  const { enqueueItems, drainQueue } = await import('../../api/_lib/job-queue.js');
  const { a } = await migratedDb();
  const job = await jobRow(a, 'stock-advisor-data-collection'), runId = await newRun(a, job);
  const [{ id: crid }] = await a.query(`INSERT INTO wealth_stock_advisor_data_collection_runs(status,summary) VALUES('running','{"instruments":1}'::jsonb) RETURNING id`);
  const tcs = { id: 'i1', asset_class: 'indian_equity', symbol: 'TCS', name: 'Tata Consultancy Services Limited', price_source_symbol: 'TCS' };
  const base = { job_id: job.id, job_run_id: runId, handler_key: job.handler_key, max_attempts: 2 };
  await enqueueItems(a, [
    { ...base, task: 'nse_xbrl', payload: { instrument: tcs, collection_run_id: crid }, priority: 43, min_budget_ms: 26000, seq: 0 },
    { ...base, task: 'fincrux_skip', payload: { reason: 'FINCRUX_API_KEY is not configured; no paid or unauthenticated request attempted.', collection_run_id: crid }, priority: 44, min_budget_ms: 1000, seq: 1 },
  ]);
  const [{ n: before }] = await a.query(`SELECT count(*)::int AS n FROM wealth_job_queue WHERE payload->>'collection_run_id'=$1`, [crid]);
  assert.equal(before, 2);
  // No announcement is stored, so the XBRL step now asks NSE's filing index directly instead of refusing outright.
  // NSE is stubbed to answer with an empty index, so this stays offline and deterministic: nothing matches the symbol,
  // and the collection still ends with no verified financial source.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).startsWith('https://www.nseindia.com/api/integrated-filing-results')
    ? new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(url);
  let out;
  try { out = await drainQueue({ db: a, runHandler: async () => { throw new Error('not used'); }, deadlineAt: Date.now() + 40000 }); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(out.processed, 2);
  const [c] = await a.query('SELECT status,finished_at,summary FROM wealth_stock_advisor_data_collection_runs WHERE id=$1', [crid]);
  const s = typeof c.summary === 'string' ? JSON.parse(c.summary) : c.summary;
  assert.equal(c.status, 'failed', 'a collection with no verified financial source is incomplete'); assert.ok(c.finished_at);
  assert.deepEqual(s.steps.map(x => x.provider + (x.ticker ? ':' + x.ticker : '')), ['NSE XBRL:TCS', 'Fincrux']);
  assert.equal(s.steps[0].status, 'no_xbrl_match', 'NSE was asked and had no filing for the symbol, rather than never being asked');
  assert.equal(s.steps[1].status, 'skipped'); assert.match(s.steps[1].note, /FINCRUX_API_KEY/);
  assert.equal(s.financials_missing, 1);
  assert.equal(typeof s.work_ms, 'number');
  const [jr] = await a.query('SELECT status,result FROM wealth_scheduled_job_runs WHERE id=$1', [runId]);
  assert.equal(jr.status, 'failed');
  const res = typeof jr.result === 'string' ? JSON.parse(jr.result) : jr.result;
  assert.equal(res.run_id, crid); assert.equal(res.tasks, 2);
  assert.equal((await jobRow(a, 'stock-advisor-data-collection')).last_status, 'failed');
});

test('a job is queued once: running it again while its items wait says busy; an empty collection finishes at once; a due job queues without running', async () => {
  const { enqueueJob } = await import('../../api/_lib/scheduled-jobs.js');
  const { a } = await migratedDb();
  const prices = await jobRow(a, 'market-price-refresh');
  const first = await enqueueJob(prices, 'manual', a);
  assert.deepEqual([first.status, first.queued], ['queued', 1]);
  assert.equal((await a.query(`SELECT status FROM wealth_job_queue WHERE job_id=$1`, [prices.id]))[0].status, 'pending', 'queueing runs nothing');
  assert.equal((await enqueueJob(prices, 'manual', a)).status, 'busy');
  // the nightly cron owns these two, so the queue refuses them outright
  for (const key of ['interest-accrual', 'backup']) {
    assert.equal((await enqueueJob(await jobRow(a, key), 'manual', a)).status, 'blocked', key + ' is run by the nightly cron, not the queue');
  }
  const collection = await jobRow(a, 'stock-advisor-data-collection');
  const empty = await enqueueJob(collection, 'manual', a);
  assert.equal(empty.status, 'succeeded', 'no holdings with a symbol and price-source symbol: nothing to collect');
  assert.equal((await a.query(`SELECT status FROM wealth_scheduled_job_runs WHERE job_id=$1`, [collection.id]))[0].status, 'succeeded');
  const research = await jobRow(a, 'stock-advisor-auto-research');
  await a.query(`UPDATE wealth_scheduled_jobs SET next_run_at=now()-interval '1 minute', enabled=true WHERE id=$1`, [research.id]);
  const due = await enqueueJob(await jobRow(a, 'stock-advisor-auto-research'), 'scheduled', a);
  assert.equal(due.status, 'queued');
  assert.ok(new Date((await jobRow(a, 'stock-advisor-auto-research')).next_run_at) > new Date(), 'a scheduled start moves the next run on');
});

test('wiring: the dispatch only queues and then drains; a worker route and cron entries keep the queue moving; the pages keep it moving while open', () => {
  const s = read('api/_lib/scheduled-jobs.js');
  assert.match(s, /queued\.push\(await enqueueJob\(job,'scheduled'\)\)/);
  assert.match(s, /drainJobQueue\(deadlineAt\)/);
  assert.doesNotMatch(s, /invoke\(handler,token\)/);
  assert.match(read('api/_lib/job-queue.js'), /DISPATCH_BUDGET_MS = 52000/);
  assert.match(read('api/_lib/job-queue.js'), /FOR UPDATE SKIP LOCKED/);
  assert.match(read('api/router.js'), /'jobs\/worker': \(\) => import\('\.\/_routes\/jobs-worker\.js'\)/);
  assert.match(read('api/_routes/jobs-run-now.js'), /runJobNow\(job\)/);
  const cfg = JSON.parse(read('vercel.json'));
  const workers = cfg.crons.filter(c => c.path === '/api/jobs/worker');
  assert.ok(workers.length >= 2 && cfg.crons.some(c => c.path === '/api/jobs/dispatch'));
  assert.ok(cfg.crons.every(c => /^\d+ \d+ \* \* \*$/.test(c.schedule)), 'every cron runs once a day (Hobby plan)');
  const worker = read('api/_routes/jobs-worker.js');
  assert.match(worker, /role!=='admin'/);
  assert.match(worker, /safeEqual/);
  const app = read('app.js');
  assert.match(app, /pumpJobQueue\('jobs',loadJobs\)/);
  assert.match(app, /pumpJobQueue\('ai-data',loadAiData\)/);
  assert.match(app, /s==='success'\|\|s==='succeeded'/, 'Scheduled jobs shows succeeded runs as Completed');
  assert.match(read('api/_routes/stock-advisor-data-collection.js'), /runStockAdvisorDataCollection\(sql,\{deadlineAt:req\.deadlineAt\}\)/);
});

test('the progress update merges the steps into the run summary without touching the other fields', async () => {
  const { a } = await migratedDb();
  const [run] = await a.query(`INSERT INTO wealth_stock_advisor_data_collection_runs(status,summary) VALUES('running','{"instruments":3}'::jsonb) RETURNING id`);
  const steps = [{ provider: 'TejHQ', ticker: 'TCS', status: 'running', started_at: '2026-11-23T13:00:00Z' }];
  await a.query(`UPDATE wealth_stock_advisor_data_collection_runs SET summary=summary||jsonb_build_object('steps',$2::jsonb) WHERE id=$1`, [run.id, JSON.stringify(steps)]);
  const [row] = await a.query('SELECT summary FROM wealth_stock_advisor_data_collection_runs WHERE id=$1', [run.id]);
  const s = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
  assert.equal(s.instruments, 3);
  assert.equal(s.steps[0].ticker, 'TCS');
});

test('wiring: the AI data route is admin only and read only, registered, and has an admin-only menu', () => {
  const route = read('api/_routes/ai-data.js');
  assert.match(route, /role === 'admin'/);
  assert.match(route, /req\.method !== 'GET'/);
  assert.doesNotMatch(route, /\b(INSERT|UPDATE|DELETE)\b\s/i);
  assert.match(read('api/router.js'), /'ai-data': \(\) => import\('\.\/_routes\/ai-data\.js'\)/);
  assert.match(read('api/_roles.js'), /ADMIN_ONLY_VIEWS = \[[^\]]*'ai-data'/);
  assert.match(read('index.html'), /data-view="ai-data"[^>]*data-owner-only/);
  const app = read('app.js');
  assert.match(app, /OWNER_VIEWS=\[[^\]]*"ai-data"/);
  assert.match(app, /view==='ai-data'/);
});
