// "Succeeded" only means the handler did not throw. In Production interest-accrual wrote 0 rows for 2 users and
// auto-research queued 0 runs in 0.0s — both shown as successes, indistinguishable from real work
// (owner's check, 2026-11-23). The page now says what each run actually did, and flags one that did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const grab = name => {
  const i = app.indexOf('function ' + name + '('); let d = 0, j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); } }
};
const jobWork = new Function(grab('jobWork') + '; return jobWork;')();

test('a run that wrote nothing is called out, and a run that did work is described', () => {
  // the exact payloads Production returned
  const idleAccrual = jobWork('interest-accrual', { ok: true, rows: 0, users: 2, failed: 0, through: '2026-11-22' });
  assert.deepEqual(idleAccrual, { text: 'no accruals written for 2 users, through 2026-11-22', idle: true });

  const idleResearch = jobWork('stock-advisor-auto-research', { ok: true, checked: 1, results: [] });
  assert.equal(idleResearch.idle, true);
  assert.match(idleResearch.text, /1 schedule checked · nothing was due/);

  const realAccrual = jobWork('interest-accrual', { rows: 7, users: 2, through: '2026-11-23' });
  assert.deepEqual(realAccrual, { text: '7 accrual rows for 2 users, through 2026-11-23', idle: false });

  const realResearch = jobWork('stock-advisor-auto-research', { checked: 1, results: [{ run_id: 'a' }, { run_id: 'b' }] });
  assert.deepEqual(realResearch, { text: '2 research runs queued', idle: false });
});

test('prices and collection read their own shapes, and a run that collected nothing is flagged', () => {
  const prices = jobWork('market-price-refresh', { failed: 0, results: [{ status: 'updated' }, { status: 'updated' }, { status: 'skipped' }] });
  assert.deepEqual(prices, { text: '2 prices updated', idle: false });
  assert.equal(jobWork('market-price-refresh', { results: [{ status: 'skipped' }] }).idle, true);

  // the real 07:58 collection
  const collection = jobWork('stock-advisor-data-collection', { instruments: 25, market_data_updated: 16, nav_updated: 4, announcements: 2, financials_verified: 0, failed: 0, tasks: 43 });
  assert.equal(collection.idle, false);
  assert.equal(collection.text, '25 holdings · 16 prices · 4 NAVs · 2 announcements');

  // the earlier failing one: everything failed, nothing collected
  const dead = jobWork('stock-advisor-data-collection', { instruments: 25, market_data_updated: 0, nav_updated: 0, announcements: 0, failed: 21 });
  assert.equal(dead.idle, true, 'all failures is not success');
  assert.match(dead.text, /21 failed/);
});

test('an unknown job still reports its numbers, and bad input never throws', () => {
  assert.equal(jobWork('something-new', { widgets: 3, errors: 0 }).text, '3 widgets');
  assert.equal(jobWork('something-new', { widgets: 0 }).idle, true, 'all-zero counters mean nothing happened');
  assert.deepEqual(jobWork('x', null), { text: '', idle: false });
  assert.deepEqual(jobWork('x', 'not json'), { text: '', idle: false });
  assert.equal(jobWork('x', '{"rows":2,"users":1}').text, '2 rows · 1 users', 'a JSON string from the driver is parsed');
  assert.match(jobWork('x', { error: 'boom' }).text, /boom/);
});

test('wiring: the result travels from the database to the card and the history', () => {
  assert.match(readFileSync(new URL('../../api/_routes/jobs.js', import.meta.url), 'utf8'),
    /SELECT id,trigger_type,status,started_at,finished_at,http_status,error,result,created_at/, 'the run result is selected');
  assert.match(app, /Nothing to do/, 'an empty run is labelled on the card');
  assert.ok((app.match(/jobs-work/g) || []).length >= 2, 'shown on the card and in the history');
  assert.match(app, /jobWork\(j\.job_key,run\.result\)/);
});
