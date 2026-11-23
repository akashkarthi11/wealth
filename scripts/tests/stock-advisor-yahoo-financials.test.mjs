// Yahoo quarterly figures are a SECONDARY source: real numbers for the analysts to reason about, never a way to open
// the evidence gate. Only the NSE-filed XBRL may mark a statement verified (api/_lib/stock-advisor-nse-xbrl.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { parseYahooFinancials, collectYahooFinancials } from '../../api/_lib/stock-advisor-yahoo-financials.js';
import { buildEvidenceContext } from '../../api/_lib/stock-advisor-evidence.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const block = (type, rows) => ({ meta: { symbol: ['BEL.NS'], type: [type] }, [type]: rows });
// Yahoo's own shape: one block per requested type, each row dated and carrying reportedValue.raw.
const PAYLOAD = { timeseries: { error: null, result: [
  block('quarterlyTotalRevenue', [
    { asOfDate: '2026-06-30', periodType: '3M', reportedValue: { raw: 40000000000 }, currencyCode: 'INR' },
    { asOfDate: '2026-09-30', periodType: '3M', reportedValue: { raw: 52000000000 }, currencyCode: 'INR' }]),
  block('quarterlyNetIncome', [{ asOfDate: '2026-09-30', periodType: '3M', reportedValue: { raw: 9000000000 }, currencyCode: 'INR' }]),
  block('quarterlyBasicEPS', [{ asOfDate: '2026-09-30', periodType: '3M', reportedValue: { raw: 12.3 }, currencyCode: 'INR' }]),
] } };

async function withYahoo(payload, fn, { status = 200 } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  try { return await fn(); } finally { globalThis.fetch = originalFetch; }
}

test('quarters are read newest first, with the figures named and empty quarters dropped', () => {
  const quarters = parseYahooFinancials(PAYLOAD);
  assert.deepEqual(quarters.map(q => q.period), ['2026-09', '2026-06'], 'newest first');
  assert.deepEqual(quarters[0].figures, { TotalRevenue: 52000000000, NetIncome: 9000000000, BasicEPS: 12.3 },
    'the "quarterly" prefix is stripped so the figure names read plainly');
  assert.equal(quarters[0].currency, 'INR');
  assert.deepEqual(quarters[1].figures, { TotalRevenue: 40000000000 });
  assert.deepEqual(parseYahooFinancials({}), []);
  assert.deepEqual(parseYahooFinancials({ timeseries: { result: [block('quarterlyTotalRevenue', [{ asOfDate: 'nope', reportedValue: { raw: 1 } }])] } }), [],
    'a row with no usable date is not a quarter');
});

test('the figures are stored UNVERIFIED and say plainly that they are not a filed document', async () => {
  const { a } = await migratedDb();
  const result = await withYahoo(PAYLOAD, () => collectYahooFinancials({ instrument: { symbol: 'BEL', name: 'Bharat Electronics Limited' }, db: a }));
  assert.equal(result.status, 'stored_unverified');
  assert.equal(result.latest_period, '2026-09');

  const [row] = await a.query(`SELECT publisher, source_type, verification_status, excerpt, evidence FROM wealth_stock_advisor_research_sources WHERE upper(ticker)='BEL'`);
  assert.equal(row.verification_status, 'unverified', 'never verified: only the filed XBRL may be');
  assert.equal(row.source_type, 'financial_statement');
  const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
  assert.equal(evidence.source_kind, 'third_party_aggregator');
  assert.match(evidence.verification_note, /never satisfy the verified financial-statement gate/);
  assert.match(evidence.verification_note, /only the NSE-filed XBRL/);
  assert.match(row.excerpt, /quarter ending 2026-09-30/, 'the excerpt carries real figures for a reader');
});

test('these rows cannot open the evidence gate, however many of them there are', () => {
  const base = [
    { ticker: 'BEL', source_type: 'market_price', title: 'p', url: 'https://x.test/p', verification_status: 'verified' },
    { ticker: 'BEL', source_type: 'technical_indicator', title: 't', url: 'https://x.test/t', verification_status: 'verified' },
  ];
  const yahoo = { ticker: 'BEL', source_type: 'financial_statement', title: 'f', url: 'https://x.test/y', verification_status: 'unverified' };
  assert.equal(buildEvidenceContext([...base, yahoo], Date.now()).action_gate, 'DATA_REQUIRED',
    'unverified figures leave the gate shut, which is the whole point');
  assert.equal(buildEvidenceContext([...base, { ...yahoo, verification_status: 'verified' }], Date.now()).action_gate, 'EVIDENCE_READY',
    'only a verified statement opens it, and only the XBRL collector writes one');
});

test('a response with no quarterly figures fails loudly instead of storing an empty row', async () => {
  const { a } = await migratedDb();
  for (const payload of [{ timeseries: { result: [] } }, { timeseries: { result: [block('quarterlyTotalRevenue', [])] } }]) {
    const r = await withYahoo(payload, () => collectYahooFinancials({ instrument: { symbol: 'BEL' }, db: a }));
    assert.equal(r.status, 'failed');
    assert.match(r.error, /no quarterly figures/);
  }
  assert.equal((await a.query(`SELECT count(*)::int AS n FROM wealth_stock_advisor_research_sources WHERE publisher LIKE 'Yahoo%'`))[0].n, 0);
  const http = await withYahoo('nope', () => collectYahooFinancials({ instrument: { symbol: 'BEL' }, db: a }), { status: 503 });
  assert.match(http.error, /HTTP 503/);
});

test('wiring: it runs after the filed XBRL and is never the thing that verifies', () => {
  const collection = read('api/_lib/stock-advisor-data-collection.js');
  // priority is an integer column, so these must be genuinely consecutive: the filed XBRL first, then these figures,
  // then Fincrux. A "between" value such as 435 sorts after 44, which is the opposite of what it looks like.
  assert.match(collection, /nse_xbrl: \{ provider: 'NSE XBRL', priority: 43/);
  assert.match(collection, /yahoo_financials: \{ provider: 'Yahoo Finance fundamentals', priority: 44/);
  assert.match(collection, /fincrux: \{ provider: 'Fincrux', priority: 45/);
  assert.match(collection, /task === 'yahoo_financials'/);
  assert.match(collection, /task === 'yahoo_financials' \|\| task === 'fincrux'\) \{ if \(r\.status === 'stored_unverified'\) summary\.financials_unverified\+\+/,
    'counted as unverified, never as a verified statement');
  const adapter = read('api/_lib/stock-advisor-yahoo-financials.js');
  assert.match(adapter, /'unverified'/);
  assert.doesNotMatch(adapter, /'verified'/, 'the adapter must never write a verified row');
  assert.match(read('api/_lib/stock-advisor-verify.js'), /disabled_fincrux_unverified/, 'the period-match promotion stays disabled');
});
