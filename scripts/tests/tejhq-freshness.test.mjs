import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTejHqEquityEvidence } from '../../api/_lib/stock-advisor-tejhq.js';

test('stale TejHQ observations are rejected before current-price storage', async () => {
  const originalFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async () => new Response(JSON.stringify([{
    date: '2026-01-05', open: 100, high: 102, low: 99, close: 101, volume: 1000
  }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await collectTejHqEquityEvidence({
      ticker: 'TEST',
      name: 'Test Limited',
      db: { query: async (sql) => { queries.push(String(sql)); return []; } }
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /stale/i);
    assert.equal(queries.some(q => q.includes('INSERT INTO wealth_instrument_prices')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
