// Five tickers were locked out of Fincrux until 23 Dec 2026 by reservation rows that held no figures: the failure
// handler could not record its outcome, so the placeholder stayed 'unverified' and the 30-day freshness check honoured
// it. The collection now releases such a placeholder itself, instead of needing a hand-written Production update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { releaseAbandonedReservations } from '../../api/_lib/stock-advisor-fincrux.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const IST_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";

const insert = (a, { ticker, publisher = 'Fincrux', evidence, status = 'unverified', when = IST_TODAY + " - interval '1 day'" }) =>
  a.query(`INSERT INTO wealth_stock_advisor_research_sources
    (run_id,ticker,source_type,title,url,publisher,retrieved_at,excerpt,evidence,verification_status)
    VALUES (NULL,$1,'financial_statement','t','https://x.test/'||$1||'/'||$2,$2,${when},'e',$3::jsonb,$4)`,
    [ticker, publisher, JSON.stringify(evidence), status]);
const statusOf = (a, ticker) => a.query(`SELECT verification_status AS s, evidence FROM wealth_stock_advisor_research_sources WHERE upper(ticker)=upper($1)`, [ticker]).then(r => r[0]);

test('an abandoned placeholder from an earlier day is released, and says why', async () => {
  const { a } = await migratedDb();
  // exactly the Production rows: a reservation with no figures in it
  await insert(a, { ticker: 'BEL', evidence: { provider: 'Fincrux', reservation: true } });
  const released = await releaseAbandonedReservations(a);
  assert.deepEqual(released, ['BEL']);

  const row = await statusOf(a, 'BEL');
  assert.equal(row.s, 'rejected', 'rejected is excluded from the 30-day freshness check, so the ticker is free again');
  const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
  assert.equal(evidence.released, true);
  assert.match(evidence.released_reason, /no figures/);
  assert.equal(evidence.reservation, true, 'the original evidence is kept, not overwritten');
});

test('a real snapshot, a row already rejected, and today’s reservation are all left alone', async () => {
  const { a } = await migratedDb();
  await insert(a, { ticker: 'ITC', evidence: { provider: 'Fincrux', financials: { quarterly_results: [{ quarter: 'Q2 FY27' }] } } });
  await insert(a, { ticker: 'HAL', evidence: { provider: 'Fincrux', reservation: true }, status: 'rejected' });
  await insert(a, { ticker: 'AWL', evidence: { provider: 'Fincrux', reservation: true }, when: 'now()' });   // today: the same-day guard owns this
  await insert(a, { ticker: 'TCS', publisher: 'NSE', evidence: { reservation: true } });                      // another publisher entirely

  assert.deepEqual(await releaseAbandonedReservations(a), [], 'nothing qualifies');
  assert.equal((await statusOf(a, 'ITC')).s, 'unverified', 'a snapshot with figures is never released');
  assert.equal((await statusOf(a, 'AWL')).s, 'unverified', 'today’s reservation is still in play');
  assert.equal((await statusOf(a, 'TCS')).s, 'unverified', 'only Fincrux rows are touched');
});

test('releasing is idempotent and reports every ticker it frees', async () => {
  const { a } = await migratedDb();
  for (const ticker of ['AWL', 'BEL', 'COCHINSHIP', 'HAL', 'HDFCBANK']) await insert(a, { ticker, evidence: { provider: 'Fincrux', reservation: true } });
  const first = await releaseAbandonedReservations(a);
  assert.deepEqual(first.sort(), ['AWL', 'BEL', 'COCHINSHIP', 'HAL', 'HDFCBANK'], 'the five Production tickers');
  assert.deepEqual(await releaseAbandonedReservations(a), [], 'running it again releases nothing');
});

test('wiring: the release runs before the day’s requests are planned, and never breaks planning', () => {
  const collection = read('api/_lib/stock-advisor-data-collection.js');
  assert.match(collection, /import \{ collectFincruxFinancials, releaseAbandonedReservations \}/);
  assert.match(collection, /const released = await releaseAbandonedReservations\(db\)\.catch\(\(\) => \[\]\)/,
    'a failure here must not stop the collection');
  assert.ok(collection.indexOf('releaseAbandonedReservations(db)') < collection.indexOf("if (String(process.env.FINCRUX_API_KEY"),
    'released before the quota is counted, so a freed ticker can be requested the same run');
  assert.match(collection, /Released ' \+ released\.length \+ ' abandoned reservation/, 'the run says what it freed');
});
