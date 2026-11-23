// USD→INR came from Yahoo's undocumented INR=X endpoint. It now comes from the published open currency API, with
// Yahoo kept only as a fallback (owner's request, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usdInrRate } from '../../api/_lib/fx-rate.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
// The real response, as returned on 23 Nov 2026 (340 currencies, trimmed here).
const REAL = { date: '2026-11-22', usd: { inr: 92.67765671, eur: 0.86, gbp: 0.75 } };

async function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = originalFetch; }
}

test('the published rate is read, and dated to the day it was published for', async () => {
  const seen = [];
  const fx = await withFetch(async (url) => { seen.push(String(url)); return new Response(JSON.stringify(REAL), { status: 200 }); },
    () => usdInrRate());
  assert.equal(fx.price, 92.67765671, 'the full precision is kept, not rounded');
  assert.equal(fx.published_for, '2026-11-22');
  assert.equal(fx.asOf.toISOString().slice(0, 10), '2026-11-22', 'a daily rate is as of its own day, not of now');
  assert.equal(fx.currency, 'INR');
  assert.match(fx.source, /currency/i);
  assert.equal(seen.length, 1, 'the second endpoint is not called when the first answers');
  assert.match(seen[0], /currencies\/usd\.json$/);
});

test('the published fallback host is tried when the first fails, and null is returned only when both do', async () => {
  const seen = [];
  const fx = await withFetch(async (url) => {
    seen.push(String(url));
    if (seen.length === 1) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify(REAL), { status: 200 });
  }, () => usdInrRate());
  assert.equal(fx.price, 92.67765671);
  assert.equal(seen.length, 2);
  assert.notEqual(new URL(seen[0]).hostname, new URL(seen[1]).hostname, 'a different host, so one CDN outage is survivable');

  const none = await withFetch(async () => new Response('nope', { status: 500 }), () => usdInrRate());
  assert.equal(none, null, 'never throws; the caller falls back');
});

test('a response without a usable rate is refused rather than stored as zero', async () => {
  for (const bad of [{ date: '2026-11-22', usd: {} }, { date: '2026-11-22', usd: { inr: 0 } },
    { date: '2026-11-22', usd: { inr: 'abc' } }, { nothing: true }]) {
    const fx = await withFetch(async () => new Response(JSON.stringify(bad), { status: 200 }), () => usdInrRate());
    assert.equal(fx, null, 'rejected: ' + JSON.stringify(bad));
  }
});

test('each attempt is audited, with no key in the endpoint and only the shape of the response', async () => {
  const written = [];
  const db = { query: async (sql, params) => { written.push({ sql, params }); return []; } };
  await withFetch(async () => new Response(JSON.stringify(REAL), { status: 200 }), () => usdInrRate({ db }));
  assert.equal(written.length, 1);
  const params = written[0].params;
  assert.equal(params[0], 'Open currency API');
  assert.equal(params[2], 'USDINR');
  const sample = JSON.parse(params[10]);
  assert.equal(sample.usd_inr, 92.67765671);
  assert.equal(sample.usd_rates, 3, 'how many currencies came back, not the currencies themselves');
});

test('wiring: the job prefers the published rate and records which source it used', () => {
  const job = read('api/_routes/refresh-market-prices.js');
  assert.match(job, /import \{usdInrRate\} from '\.\.\/_lib\/fx-rate\.js'/);
  assert.match(job, /const fx=await usdInrRate\(\{db:sql\}\)/);
  assert.match(job, /\|\| await yahooQuote\('INR=X'\)/, 'Yahoo is the fallback, not the primary');
  assert.match(job, /fx_source:fx\?\.source\|\|null/, 'the run records which source gave the rate');
  assert.match(read('api/_lib/fx-rate.js'), /cdn\.jsdelivr\.net\/npm\/@fawazahmed0\/currency-api/);
});
