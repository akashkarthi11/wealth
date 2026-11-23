// Stock Advisor: financial statements are verified by PERIOD MATCH with an official NSE results announcement (owner's rule, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { periodsIn, fiscalQuarterEnd, latestFincruxPeriod, verifyFinancialStatements, announcementIsFor, periodsPublishedBy } from '../../api/_lib/stock-advisor-verify.js';
import { buildEvidenceContext } from '../../api/_lib/stock-advisor-evidence.js';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const has = (text, p) => periodsIn(text).has(p);

test('reading reporting periods from NSE and Fincrux text: day-first dates, month names, fiscal quarters', () => {
  assert.ok(has('Financial Results for the quarter ended 30-09-2026', '2026-09'));
  assert.ok(has('Results for period ended 30/09/2026', '2026-09'));
  assert.ok(has('quarter ended September 30, 2026', '2026-09'));
  assert.ok(has('Unaudited results 30 Sep 2026', '2026-09'));
  assert.ok(has('Sep 2026', '2026-09'));
  assert.ok(has('2026-09-30', '2026-09'));
  assert.ok(has('Q2 FY27', '2026-09') && has('Q2FY2027', '2026-09'));
  assert.ok(has('Q4 FY27', '2027-03') && has('Q1 FY27', '2026-06') && has('Q3 FY27', '2026-12'));
  assert.equal(fiscalQuarterEnd(5, 27), null);
  assert.equal(periodsIn('no dates here, revenue 1,234').size, 0);
  assert.equal(periodsIn('13/13/2026 and 45-02-2026').size, 0, 'impossible months and days are not periods');
  assert.equal(periodsIn('Marketing 2026 plan, Decision 2026, Junior 2026, Augmented 2026').size, 0, 'only whole month names count, not words that start with one');
  assert.ok(has('quarter ended 30 June 2026', '2026-06') && has('Sept 2026', '2026-09') && has('March 31, 2027', '2027-03'));
});

test('the latest quarter of a Fincrux snapshot is found from labels and values, in any layout', () => {
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ quarter: 'Q1 FY27' }, { quarter: 'Q2 FY27' }] } }), '2026-09');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ metric: 'Sales', 'Jun 2026': '100', 'Sep 2026': '110' }] } }), '2026-09');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ date: '2026-03-31' }, { date: '2026-06-30' }] } }), '2026-06');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ revenue: '100' }] } }), null);
  assert.equal(latestFincruxPeriod({}), null);
});

async function setup() {
  const { a } = await migratedDb();
  const src = (o) => a.query(`INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
    VALUES (NULL,$1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9::jsonb,'unverified') RETURNING id`, [o.ticker, o.type, o.title, o.url, o.publisher, o.published || null, o.retrieved || '2026-11-22T10:00:00Z', o.excerpt || '', JSON.stringify(o.evidence || {})]).then(r => r[0].id);
  const fincrux = (ticker, quarter) => src({ ticker, type: 'financial_statement', title: 'Financial statements — ' + ticker, url: 'https://api.fincrux.org/api/financials/' + ticker, publisher: 'Fincrux',
    evidence: { provider: 'Fincrux', financials: { quarterly_results: [{ quarter }] } } });
  const nse = (ticker, title, o = {}) => src({ ticker, type: 'financial_statement', title, url: 'https://nsearchives.nseindia.com/corporate/' + ticker + '/' + Math.random().toString(36).slice(2), publisher: 'NSE',
    published: o.published || '2026-11-10T10:00:00Z', excerpt: o.excerpt || '', evidence: { feed_label: o.feed || 'Financial results', official_exchange_feed: true } });
  const status = id => a.query(`SELECT verification_status AS s, evidence FROM wealth_stock_advisor_research_sources WHERE id=$1`, [id]).then(r => r[0]);
  return { a, fincrux, nse, status };
}

test('a Fincrux statement whose period matches an official NSE results announcement becomes verified, and says how', async () => {
  const { a, fincrux, nse, status } = await setup();
  const fx = await fincrux('TCS', 'Q2 FY27');
  const other = await nse('TCS', 'Board meeting intimation', { feed: 'Board meetings' });
  const n = await nse('TCS', 'Tata Consultancy Services - Financial Results for the quarter ended 30-09-2026');
  const r = await verifyFinancialStatements(a, 'tcs', { now: NOW, name: 'Tata Consultancy Services Limited' });
  assert.deepEqual([r.status, r.period], ['verified', '2026-09']);
  const row = await status(fx);
  assert.equal(row.s, 'verified');
  assert.equal(row.evidence.verification.rule, 'period_match_nse');
  assert.equal(row.evidence.verification.nse_source_id, n);
  assert.match(row.evidence.verification.note, /figures were not compared/);
  assert.equal((await status(other)).s, 'unverified', 'other announcements are untouched');
  assert.equal((await verifyFinancialStatements(a, 'TCS', { now: NOW })).status, 'already_verified', 'running it again changes nothing');
});

test('it stays unverified when there is no NSE announcement for that period, for that company, from that feed, or one that is too old', async () => {
  const { a, fincrux, nse, status } = await setup();
  const fx = await fincrux('INFY', 'Q2 FY27');
  await nse('INFY', 'Financial Results for the quarter ended 30-06-2026');                                              // another period
  await nse('TCS', 'Financial Results for the quarter ended 30-09-2026');                                               // another company
  await nse('INFY', 'Annual report for the quarter ended 30-09-2026', { feed: 'Annual reports' });                       // not a results announcement
  await nse('INFY', 'Financial Results for the quarter ended 30-09-2026', { published: '2025-01-05T00:00:00Z' });          // older than 400 days
  const r = await verifyFinancialStatements(a, 'INFY', { now: NOW });
  assert.equal(r.status, 'no_matching_nse_announcement');
  assert.equal((await status(fx)).s, 'unverified');
  assert.equal((await verifyFinancialStatements(a, 'WIPRO', { now: NOW })).status, 'no_fincrux_data');
  const nofx = await setup();
  await nofx.fincrux('ITC', 'no period given');
  assert.equal((await verifyFinancialStatements(nofx.a, 'ITC', { now: NOW })).status, 'no_period_in_fincrux_data');
});

test('the announcement must be about this company: a subsidiary or a different company that shares the name does not count', () => {
  const T = 'Tata Motors Limited';
  assert.equal(announcementIsFor('Tata Motors Limited - Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', T), true);
  assert.equal(announcementIsFor('Tata Motors - Unaudited Financial Results', 'TATAMOTORS', T), true);
  assert.equal(announcementIsFor('TATAMOTORS - Financial Results', 'TATAMOTORS', ''), true, 'the exchange symbol alone is enough when no name is saved');
  assert.equal(announcementIsFor('Tata Motors Finance Limited - Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', T), false, 'a subsidiary');
  assert.equal(announcementIsFor('Tata Consultancy Services - Financial Results', 'TATAMOTORS', T), false);
  assert.equal(announcementIsFor('Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', ''), false, 'no company named, no name saved: not counted');
  assert.deepEqual(periodsPublishedBy('results for 30-09-2026, meeting on 15-12-2026', '2026-11-10T00:00:00Z'), ['2026-09'], 'a date after publication is a meeting date, not a period');
});

test('a Fincrux statement older than the newest NSE results for the company is not verified, and a subsidiary announcement does not verify it', async () => {
  const { a, fincrux, nse, status } = await setup();
  const fx = await fincrux('TATAMOTORS', 'Q1 FY27');   // Jun 2026
  await nse('TATAMOTORS', 'Tata Motors Limited - Financial Results for the quarter ended 30-06-2026', { published: '2026-08-10T00:00:00Z' });
  await nse('TATAMOTORS', 'Tata Motors Limited - Financial Results for the quarter ended 30-09-2026', { published: '2026-11-10T00:00:00Z' });
  const stale = await verifyFinancialStatements(a, 'TATAMOTORS', { now: NOW, name: 'Tata Motors Limited' });
  assert.deepEqual([stale.status, stale.period, stale.nse_latest_period], ['fincrux_older_than_nse', '2026-06', '2026-09']);
  assert.equal((await status(fx)).s, 'unverified', 'the older June announcement does not verify a stale June snapshot');
  const other = await setup();
  const fx2 = await other.fincrux('TATAMOTORS', 'Q2 FY27');
  await other.nse('TATAMOTORS', 'Tata Motors Finance Limited - Financial Results for the quarter ended 30-09-2026');
  assert.equal((await verifyFinancialStatements(other.a, 'TATAMOTORS', { now: NOW, name: 'Tata Motors Limited' })).status, 'no_matching_nse_announcement');
  assert.equal((await other.status(fx2)).s, 'unverified');
  await other.nse('TATAMOTORS', 'Tata Motors Limited - Financial Results for the quarter ended 30-09-2026');
  assert.equal((await verifyFinancialStatements(other.a, 'TATAMOTORS', { now: NOW, name: 'Tata Motors Limited' })).status, 'verified', "the company's own announcement does");
});

test('a verified financial statement lets the evidence gate count it; an unverified one does not', () => {
  const base = [
    { ticker: 'TCS', source_type: 'market_price', title: 'p', url: 'https://x.test/p', verification_status: 'verified' },
    { ticker: 'TCS', source_type: 'technical_indicator', title: 't', url: 'https://x.test/t', verification_status: 'verified' },
  ];
  const fs = s => ({ ticker: 'TCS', source_type: 'financial_statement', title: 'f', url: 'https://x.test/f', verification_status: s });
  assert.equal(buildEvidenceContext([...base, fs('unverified')], NOW).action_gate, 'DATA_REQUIRED');
  assert.equal(buildEvidenceContext([...base, fs('verified')], NOW).action_gate, 'EVIDENCE_READY');
});

test('wiring: the debate and the data collection both run the period match after the providers', () => {
  const debate = readFileSync(new URL('../../api/_lib/stock-advisor-debate.js', import.meta.url), 'utf8');
  const coll = readFileSync(new URL('../../api/_lib/stock-advisor-data-collection.js', import.meta.url), 'utf8');
  assert.ok(debate.indexOf('collectNseNews({ticker:run.ticker') < debate.indexOf('verifyFinancialStatements(sql,run.ticker,{name:run.stock_name})'), 'after NSE news in the debate');
  assert.match(coll, /verifyFinancialStatements\(db, i\.symbol, \{ name: i\.name \}\)/);
  assert.match(coll, /financials_verified/);
});
