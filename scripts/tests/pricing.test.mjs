import test from 'node:test';
import assert from 'node:assert/strict';

const { makePricer } = await import('../../api/_routes/refresh-market-prices.js');
const T = Date.parse('2026-11-10T09:00:00Z') / 1000;

function fakeFetch(map) {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    for (const [pattern, body] of Object.entries(map)) if (String(url).includes(pattern)) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}
const yahoo = (price, currency) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: T, currency } }] } });
const fx = { price: 88, asOf: new Date(T * 1000) };

test('gold futures convert USD/oz to INR/g with the USD/INR rate', async () => {
  fakeFetch({ 'GC%3DF': yahoo(2700, 'USD') });
  const q = await makePricer(fx)({ assetClass: 'precious_metal', symbol: 'GC=F', currency: 'INR' });
  assert.equal(q.currency, 'INR');
  assert.ok(Math.abs(q.unitPrice - 2700 * 88 / 31.1034768) < 1e-9);
});

test('USD prices are refused without an exchange rate (never invented)', async () => {
  fakeFetch({ NVDA: yahoo(168.45, 'USD') });
  await assert.rejects(makePricer(null)({ assetClass: 'us_equity', symbol: 'NVDA', currency: 'USD' }), /USD\/INR reference rate unavailable/);
  const ok = await makePricer(fx)({ assetClass: 'us_equity', symbol: 'NVDA', currency: 'USD' });
  assert.equal(ok.fx.price, 88);
});

test('mutual fund: scheme code resolved by name once, NAV read, result shared between v1 and v2', async () => {
  const calls = fakeFetch({
    '/mf/search': [{ schemeCode: 118989, schemeName: 'Nippon India Large Cap Fund - Direct Plan - Growth' }],
    '/mf/118989/latest': { data: [{ nav: '91.25', date: '10-11-2026' }] },
  });
  const price = makePricer(fx);
  const asset = { assetClass: 'indian_mutual_fund', symbol: 'Nippon India Large Cap Fund - Direct Plan - Growth', currency: 'INR' };
  const [a, b] = await Promise.all([price(asset), price(asset)]);
  assert.equal(a.unitPrice, 91.25);
  assert.equal(a.resolvedSymbol, '118989');
  assert.equal(a, b, 'same promise result for both models');
  assert.equal(calls.filter(c => c.includes('/mf/search')).length, 1);
  assert.equal(a.asOf.toISOString().slice(0, 10), '2026-11-10');
});

test('an invalid quote is an error, not a zero price', async () => {
  fakeFetch({ LT: yahoo(0, 'INR') });
  await assert.rejects(makePricer(fx)({ assetClass: 'indian_equity', symbol: 'LT.NS', currency: 'INR' }), /No valid quote/);
});
