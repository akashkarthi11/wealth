// NSE announcements are titled with the registered company name, but holdings are saved under the symbol
// (Production stores name="ONGC", and TATAGOLD/TATSILV are ETFs that are not on the equity list at all).
// Every NSE master list is read and merged, so a new holding of any type resolves itself. Names come from NSE, never from this code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNseSymbolList, nseSymbolNames, resetNseSymbolNames, collectNseNewsBatch, nseFeedItemMatchesAny, cleanNseFeedItemMatches } from '../../api/_lib/stock-advisor-live-evidence.js';

const EQUITIES = [
  'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, ISIN NUMBER',
  'ONGC,Oil & Natural Gas Corporation Limited,EQ,19-JUL-1995,INE213A01029',
  'LT,"Larsen & Toubro Limited",EQ,23-JUN-2004,INE018A01030',
  'TRENT,Trent Limited,EQ,27-JUL-1998,INE849A01020',
  'ZZZZ,ZZZZ,EQ,01-JAN-2020,INE000A01000',
].join('\n');
// A different layout on purpose: the ETF list names its columns differently from the equity list.
const ETFS = [
  'Symbol,Underlying,Security Name,ISIN',
  'TATAGOLD,Gold,Tata Gold Exchange Traded Fund,INE0ONG01011',
  'TATSILV,Silver,Tata Silver Exchange Traded Fund,INE0ONG01029',
].join('\n');

const feedXml = (titles) => '<rss><channel>' + titles.map((t, i) =>
  '<item><title><![CDATA[' + t + ']]></title><link>https://www.nseindia.com/a' + i + '</link>' +
  '<description><![CDATA[' + t + ']]></description><pubDate>Mon, 23 Nov 2026 10:00:00 +0530</pubDate></item>').join('') + '</channel></rss>';

// Answers the real list URLs; every other NSE list 404s, which is what an unknown or moved file looks like.
function mockNse(titles, { equities = EQUITIES, etfs = ETFS, counts = null } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith('.csv')) {
      if (counts) counts.push(u.split('/').pop());
      if (u.includes('EQUITY_L.csv') && !u.includes('SME')) return equities === null ? new Response('x', { status: 503 }) : new Response(equities, { status: 200 });
      if (u.includes('etfseclist')) return etfs === null ? new Response('x', { status: 503 }) : new Response(etfs, { status: 200 });
      return new Response('not found', { status: 404 });
    }
    return new Response(feedXml(titles), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  };
}
async function withNse(fetchImpl, fn) {
  resetNseSymbolNames();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = originalFetch; resetNseSymbolNames(); }
}

test('any NSE list is parsed by reading its own header, whatever the column names are', () => {
  const eq = parseNseSymbolList(EQUITIES);
  assert.equal(eq.get('ONGC'), 'Oil & Natural Gas Corporation Limited');
  assert.equal(eq.get('LT'), 'Larsen & Toubro Limited', 'a quoted field containing a comma survives');
  assert.equal(eq.get('ZZZZ'), undefined, 'a row whose name only repeats the symbol adds nothing');

  const etf = parseNseSymbolList(ETFS);
  assert.equal(etf.get('TATAGOLD'), 'Tata Gold Exchange Traded Fund', 'Security Name is found without the equity list layout');
  assert.equal(etf.size, 2);

  assert.equal(parseNseSymbolList('').size, 0);
  assert.equal(parseNseSymbolList('A,B\n1,2').size, 0, 'no symbol/name header means no names, not a wrong guess');
});

test('the lists are merged, each one reported, and a list that cannot be read never stops the others', async () => {
  const names = await withNse(mockNse([]), () => nseSymbolNames());
  assert.equal(names.map.get('ONGC'), 'Oil & Natural Gas Corporation Limited');
  assert.equal(names.map.get('TATAGOLD'), 'Tata Gold Exchange Traded Fund', 'an ETF resolves from the ETF list');
  assert.equal(names.map.size, 5);
  assert.deepEqual(names.sources, [{ label: 'Equities', symbols: 3 }, { label: 'ETFs', symbols: 2 }]);
  assert.deepEqual(names.errors.map(e => e.list).sort(), ['Debt', 'SME']);
  assert.ok(names.errors.every(e => /404/.test(e.error)));
});

test('a holding saved under its symbol matches an announcement titled with the registered name — equity and ETF alike', async () => {
  for (const [symbol, title] of [
    ['ONGC', 'Oil & Natural Gas Corporation Limited - Financial Results for the quarter ended 30-09-2026'],
    ['TATAGOLD', 'Tata Gold Exchange Traded Fund - Notice of Record Date'],
  ]) {
    const stored = [];
    const batch = await withNse(mockNse([title]), () => collectNseNewsBatch({
      instruments: [{ symbol, name: symbol }],   // exactly what Production stores
      db: { query: async (sql, params = []) => { stored.push(params[0]); return []; } },
      feedLabels: ['Financial results'],
    }));
    assert.equal(batch.stored, 1, symbol + ' should have matched');
    assert.deepEqual(stored, [symbol]);
    assert.equal(batch.official_names, 5);
    assert.deepEqual(batch.name_lists, [{ label: 'Equities', symbols: 3 }, { label: 'ETFs', symbols: 2 }]);
  }
});

test('with no list reachable at all, matching still works on the saved name and the run says so', async () => {
  const batch = await withNse(mockNse(['Trent Limited - Board Meeting Intimation'], { equities: null, etfs: null }), () =>
    collectNseNewsBatch({ instruments: [{ symbol: 'TRENT', name: 'Trent' }], db: { query: async () => [] }, feedLabels: ['Board meetings'] }));
  assert.equal(batch.stored, 1, 'the saved name still matches');
  assert.equal(batch.official_names, 0);
  assert.equal(batch.name_list_errors.length, 4, 'all four lists are reported, separately from feed problems');
  assert.ok(batch.name_list_errors.some(e => e.list === 'Equities' && /503/.test(String(e.error))));
  assert.equal(batch.feed_errors, 0, 'a list that will not load is not a feed failure');
});

test('an announcement that merely contains the word is not matched — the title must name the company', async () => {
  // Real Production false positive: this filing was stored against RELIANCE because its body said
  // "any acquisition made in reliance upon exemption provided for in regulation 10".
  const lotus = 'Lotus Eye Hospital and Institute Limited';
  assert.equal(cleanNseFeedItemMatches(lotus, 'RELIANCE', 'RELIANCE'), false);
  assert.equal(cleanNseFeedItemMatches(lotus, 'RELIANCE', 'Reliance Industries Limited'), false);
  // a different company sharing the first word is not the holding either
  assert.equal(cleanNseFeedItemMatches('Reliance Power Limited - Board Meeting', 'RELIANCE', 'Reliance Industries Limited'), false);
  // the real one still matches, by registered name or by symbol
  assert.equal(cleanNseFeedItemMatches('Reliance Industries Limited - Financial Results', 'RELIANCE', 'Reliance Industries Limited'), true);
  assert.equal(cleanNseFeedItemMatches('RELIANCE - Board Meeting Intimation', 'RELIANCE', 'RELIANCE'), true);
  assert.equal(cleanNseFeedItemMatches('Oil & Natural Gas Corporation Limited - Results', 'ONGC', 'Oil and Natural Gas Corporation Limited'), true, 'ampersand and "and" are the same name');

  const stored = [];
  const batch = await withNse(mockNse([lotus]), () => collectNseNewsBatch({
    instruments: [{ symbol: 'RELIANCE', name: 'RELIANCE' }],
    db: { query: async (sql, params = []) => { stored.push(params[0]); return []; } },
    feedLabels: ['Announcements'],
  }));
  assert.deepEqual(stored, [], 'nothing is written for another company’s filing');
  assert.equal(batch.stored, 0);
});

test('nothing is assumed for a symbol no list names', async () => {
  const batch = await withNse(mockNse(['Bharat Electronics Limited - Financial Results']), () =>
    collectNseNewsBatch({ instruments: [{ symbol: 'BEL', name: 'BEL' }], db: { query: async () => [] }, feedLabels: ['Financial results'] }));
  assert.equal(batch.stored, 0, 'BEL is on no list, so nothing is guessed about its name');
  assert.equal(batch.status, 'no_results', 'a 404 on an optional name list is not a feed failure');
  assert.equal(batch.feed_errors, 0);
  assert.match(String(batch.errors.at(-1).error), /NSE lists loaded: Equities 3, ETFs 2/);
  assert.equal(nseFeedItemMatchesAny('Trent Limited results', 'TRENT', ['Trent', 'Trent Limited']), true);
  assert.equal(nseFeedItemMatchesAny('Infosys results', 'TRENT', ['Trent', 'Trent Limited']), false);
});

test('each list is downloaded once per run, not once per feed', async () => {
  const counts = [];
  await withNse(mockNse([], { counts }), async () => {
    for (const label of ['Announcements', 'Financial results', 'Board meetings']) {
      await collectNseNewsBatch({ instruments: [{ symbol: 'ONGC', name: 'ONGC' }], db: { query: async () => [] }, feedLabels: [label] });
    }
    assert.equal(counts.length, 4, 'four lists, fetched once each and cached across the three feeds');
    assert.equal(new Set(counts).size, 4);
  });
});
