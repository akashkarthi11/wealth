import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { periodsIn, fiscalQuarterEnd, latestFincruxPeriod, verifyFinancialStatements, announcementIsFor, periodsPublishedBy } from '../../api/_lib/stock-advisor-verify.js';
import { buildEvidenceContext } from '../../api/_lib/stock-advisor-evidence.js';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const has = (text, p) => periodsIn(text).has(p);

test('reading reporting periods from NSE text: day-first dates, month names and fiscal quarters', () => {
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
  assert.equal(periodsIn('13/13/2026 and 45-02-2026').size, 0);
  assert.equal(periodsIn('Marketing 2026 plan, Decision 2026, Junior 2026, Augmented 2026').size, 0);
  assert.ok(has('quarter ended 30 June 2026', '2026-06') && has('Sept 2026', '2026-09') && has('March 31, 2027', '2027-03'));
});

test('legacy Fincrux period extraction remains informational only', () => {
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ quarter: 'Q1 FY27' }, { quarter: 'Q2 FY27' }] } }), '2026-09');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ metric: 'Sales', 'Jun 2026': '100', 'Sep 2026': '110' }] } }), '2026-09');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ date: '2026-03-31' }, { date: '2026-06-30' }] } }), '2026-06');
  assert.equal(latestFincruxPeriod({ financials: { quarterly_results: [{ revenue: '100' }] } }), null);
  assert.equal(latestFincruxPeriod({}), null);
});

test('announcement matching requires the correct company and periods after publication are ignored', () => {
  const company = 'Tata Motors Limited';
  assert.equal(announcementIsFor('Tata Motors Limited - Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', company), true);
  assert.equal(announcementIsFor('Tata Motors Finance Limited - Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', company), false);
  assert.equal(announcementIsFor('Financial Results for the quarter ended 30-09-2026', 'TATAMOTORS', ''), false);
  assert.deepEqual(periodsPublishedBy('results for 30-09-2026, meeting on 15-12-2026', '2026-11-10T00:00:00Z'), ['2026-09']);
});

test('Fincrux is never promoted to verified by an NSE announcement period match', async () => {
  let writes = 0;
  const result = await verifyFinancialStatements({ query: async () => { writes++; throw new Error('must not query'); } }, 'TCS', { now: NOW });
  assert.equal(result.status, 'disabled_fincrux_unverified');
  assert.equal(writes, 0);
});

test('the evidence gate counts a parsed verified NSE statement but not an unverified Fincrux statement', () => {
  const base = [
    { ticker: 'TCS', source_type: 'market_price', title: 'p', url: 'https://x.test/p', verification_status: 'verified' },
    { ticker: 'TCS', source_type: 'technical_indicator', title: 't', url: 'https://x.test/t', verification_status: 'verified' },
  ];
  const fs = (publisher, status) => ({ ticker: 'TCS', source_type: 'financial_statement', title: 'f', url: 'https://x.test/f', publisher, verification_status: status });
  assert.equal(buildEvidenceContext([...base, fs('Fincrux', 'unverified')], NOW).action_gate, 'DATA_REQUIRED');
  assert.equal(buildEvidenceContext([...base, fs('NSE', 'verified')], NOW).action_gate, 'EVIDENCE_READY');
});

test('wiring: debate never verifies Fincrux and data collection queues one NSE XBRL task per equity', () => {
  const debate = readFileSync(new URL('../../api/_lib/stock-advisor-debate.js', import.meta.url), 'utf8');
  const coll = readFileSync(new URL('../../api/_lib/stock-advisor-data-collection.js', import.meta.url), 'utf8');
  assert.doesNotMatch(debate, /verifyFinancialStatements/);
  // The debate's own gap-filling pass (2026-11-24) now tries NSE XBRL synchronously on the first step too, not only
  // through the nightly queue - but Fincrux is still only ever tried after that, and only as a fallback.
  assert.match(debate, /collectNseXbrlFinancialStatement/);
  const xbrlCall = debate.indexOf('refreshes.nse_xbrl=await collectNseXbrlFinancialStatement');
  const fincruxCall = debate.indexOf('refreshes.fincrux=await collectFincruxFinancials');
  assert.ok(xbrlCall > 0 && fincruxCall > xbrlCall, 'the verified path is always attempted before the unverified fallback');
  assert.match(coll, /collectNseXbrlFinancialStatement/);
  assert.match(coll, /add\('nse_xbrl', \{ instrument: slim\(e\) \}\)/);
  assert.match(coll, /financials_verified/);
});
