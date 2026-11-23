// When a provider returns nothing usable, the run must say WHY, so the next failure needs no database dig.
// In Production all 6 NSE feeds were read and 0 of 16 holdings matched, and Fincrux returned a payload with no statement
// rows — neither recorded enough to tell an empty feed from an unmatched one (owner's Production run, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNseNewsBatch } from '../../api/_lib/stock-advisor-live-evidence.js';
import { normalizeFincruxFinancials } from '../../api/_lib/stock-advisor-fincrux.js';

const feed = (items) => '<rss><channel>' + items.map(t =>
  '<item><title><![CDATA[' + t + ']]></title><link>https://www.nseindia.com/x' + Math.random().toString(36).slice(2) + '</link>' +
  '<description><![CDATA[' + t + ']]></description><pubDate>Mon, 23 Nov 2026 10:00:00 +0530</pubDate></item>').join('') + '</channel></rss>';

async function run(titles, instruments) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(feed(titles), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  try {
    return await collectNseNewsBatch({ instruments, db: { query: async () => [] }, feedLabels: ['Announcements'] });
  } finally { globalThis.fetch = originalFetch; }
}

test('a feed that carried announcements but matched nothing is reported differently from a feed that was empty', async () => {
  const held = [{ symbol: 'ONGC', name: 'ONGC' }];   // the name Production actually stores: the symbol, not the company
  const unmatched = await run(['Oil & Natural Gas Corporation Limited - Financial Results for the quarter ended 30-09-2026'], held);
  assert.equal(unmatched.status, 'no_results');
  assert.equal(unmatched.items_seen, 1, 'the announcement was read');
  assert.deepEqual(unmatched.feeds.map(f => [f.label, f.items, f.matched]), [['Announcements', 1, 0]]);
  assert.match(unmatched.feeds[0].sample[0], /Oil & Natural Gas/, 'a real title is kept, so the mismatch is visible');
  assert.match(String(unmatched.errors.at(-1).error), /none named a saved holding/);
  assert.match(String(unmatched.errors.at(-1).error), /real company name, not just its symbol/);

  const empty = await run([], held);
  assert.equal(empty.items_seen, 0);
  assert.match(String(empty.errors.at(-1).error), /no announcements at all/);
});

test('a holding whose stored name matches the announcement is still collected, and counted against its feed', async () => {
  const batch = await run(['Trent Limited - Board Meeting Intimation'], [{ symbol: 'TRENT', name: 'Trent' }]);
  assert.equal(batch.stored, 1);
  assert.deepEqual(batch.feeds.map(f => [f.items, f.matched]), [[1, 1]]);
  assert.equal(batch.status, 'ok');
});

test('Fincrux naming nothing usable reports the keys it did return, so the shape can be checked without another request', () => {
  const ok = { success: true, trading_symbol: 'TCS', company: 'Tata Consultancy Services' };
  assert.throws(() => normalizeFincruxFinancials({ ...ok, data: { about: 'text', ratios: [], top_ratios: {} } }, 'TCS'),
    /no quarterly, P&L, balance-sheet or cash-flow statement rows\. data keys: about, ratios, top_ratios/);
  assert.throws(() => normalizeFincruxFinancials({ ...ok, meta: {} }, 'TCS'),
    /no structured financial data\. Response keys: success, trading_symbol, company, meta/);
});
