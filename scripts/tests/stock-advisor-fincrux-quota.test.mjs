// Fincrux allows five requests per IST day. On 23 Nov all five were spent and returned nothing usable, and the rows
// they left behind are indistinguishable from a real snapshot — which blocks those tickers from being retried for
// 30 days. A slot must never be spent for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { collectFincruxFinancials, clearFincruxDailyUsageMemory } from '../../api/_lib/stock-advisor-fincrux.js';

const instrument = symbol => ({ id: 'i-' + symbol, symbol, name: symbol + ' Limited', asset_class: 'indian_equity' });
const row = (a, ticker) => a.query(`SELECT verification_status AS status, left(COALESCE(excerpt,''),200) AS excerpt,
  jsonb_exists(evidence,'reservation') AS placeholder, jsonb_exists(evidence,'financials') AS has_data, evidence->>'error' AS err
  FROM wealth_stock_advisor_research_sources WHERE publisher='Fincrux' AND upper(ticker)=upper($1)
  ORDER BY retrieved_at DESC LIMIT 1`, [ticker]).then(r => r[0] || null);

async function withFincrux(payload, fn, { status = 200 } = {}) {
  clearFincruxDailyUsageMemory();
  const originalFetch = globalThis.fetch, key = process.env.FINCRUX_API_KEY;
  process.env.FINCRUX_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  try { return await fn(); }
  finally { globalThis.fetch = originalFetch; if (key === undefined) delete process.env.FINCRUX_API_KEY; else process.env.FINCRUX_API_KEY = key; }
}

// Exactly what Fincrux returned today: a successful response carrying no statement arrays.
const emptyFor = ticker => ({ success: true, trading_symbol: ticker, company: ticker + ' Limited',
  data: { about: 'Defence electronics.', ratios: [{ name: 'ROE', value: '21%' }], top_ratios: { pe: '42' } } });
const EMPTY = emptyFor('BEL');

test('a spent slot that returned no statements must not masquerade as a stored snapshot', async () => {
  const { a } = await migratedDb();
  const result = await withFincrux(EMPTY, () => collectFincruxFinancials({ instrument: instrument('BEL'), db: a }));
  assert.equal(result.status, 'failed');

  const stored = await row(a, 'BEL');
  assert.ok(stored, 'the reservation row exists');
  assert.notEqual(stored.status, 'unverified',
    'left as "unverified" it looks like a real snapshot and the 30-day cache check blocks this ticker for a month');
  assert.equal(stored.placeholder, false, 'the reservation placeholder must not survive as the stored evidence');
});

test('a request that is spent anyway keeps whatever the response did carry, and records its shape', async () => {
  const { a } = await migratedDb();
  await withFincrux(EMPTY, () => collectFincruxFinancials({ instrument: instrument('BEL'), db: a }));
  const result = await withFincrux(emptyFor('ITC'), () => collectFincruxFinancials({ instrument: instrument('ITC'), db: a }));
  assert.equal(result.status, 'failed');
  assert.match(String(result.error || ''), /data keys: about, ratios, top_ratios/,
    'the call reports the keys the response did contain');
  const stored = await row(a, 'ITC');
  assert.ok(stored, 'the spent request left a row behind');
  assert.match(String(stored.err || '') + ' ' + String(stored.excerpt || ''), /about, ratios, top_ratios/,
    'and they are stored, so the next decision needs no further request');
});

test('the same ticker is not tried twice in one day, but is no longer locked out for 30 days', async () => {
  const { a } = await migratedDb();
  await withFincrux(EMPTY, () => collectFincruxFinancials({ instrument: instrument('BEL'), db: a }));

  // same IST day: refused on purpose, so a second slot is not spent on a ticker already attempted
  const sameDay = await withFincrux(EMPTY, () => collectFincruxFinancials({ instrument: instrument('BEL'), db: a }));
  assert.equal(sameDay.status, 'skipped');
  assert.match(String(sameDay.reason), /already attempted for this stock today|already requested today|quota/);

  // a later day: the failed row must NOT count as a 30-day cached snapshot
  await a.query(`UPDATE wealth_stock_advisor_research_sources SET retrieved_at = now() - interval '2 days'
    WHERE publisher='Fincrux' AND upper(ticker)='BEL'`);
  clearFincruxDailyUsageMemory();
  let called = 0;
  const good = { success: true, trading_symbol: 'BEL', company: 'Bharat Electronics Limited',
    data: { quarterly_results: [{ quarter: 'Q2 FY27', sales: '100' }] } };
  const originalFetch = globalThis.fetch, key = process.env.FINCRUX_API_KEY;
  process.env.FINCRUX_API_KEY = 'test-key';
  globalThis.fetch = async () => { called++; return new Response(JSON.stringify(good), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    const second = await collectFincruxFinancials({ instrument: instrument('BEL'), db: a });
    assert.equal(called, 1, 'a failed attempt must not count as a 30-day cached snapshot');
    assert.equal(second.status, 'stored_unverified');
    assert.equal((await row(a, 'BEL')).has_data, true);
  } finally { globalThis.fetch = originalFetch; if (key === undefined) delete process.env.FINCRUX_API_KEY; else process.env.FINCRUX_API_KEY = key; }
});

test('a real snapshot still stops a second request the same month, so slots are not spent twice on one ticker', async () => {
  const { a } = await migratedDb();
  const good = { success: true, trading_symbol: 'ITC', company: 'ITC Limited', data: { quarterly_results: [{ quarter: 'Q2 FY27' }] } };
  let called = 0;
  const originalFetch = globalThis.fetch, key = process.env.FINCRUX_API_KEY;
  process.env.FINCRUX_API_KEY = 'test-key';
  globalThis.fetch = async () => { called++; return new Response(JSON.stringify(good), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    assert.equal((await collectFincruxFinancials({ instrument: instrument('ITC'), db: a })).status, 'stored_unverified');
    const again = await collectFincruxFinancials({ instrument: instrument('ITC'), db: a });
    assert.equal(called, 1, 'the fresh snapshot is reused instead of spending another slot');
    assert.equal(again.status, 'skipped');
  } finally { globalThis.fetch = originalFetch; if (key === undefined) delete process.env.FINCRUX_API_KEY; else process.env.FINCRUX_API_KEY = key; }
});
