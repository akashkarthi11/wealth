// TejHQ end-of-day rows must actually be accepted. In Production every row was rejected because the date check was written
// /^\\d{4}-\\d{2}-\\d{2}$/ — in a regex literal \\d means "a backslash, then d", so no real date ever matched and all 16
// holdings reported "TejHQ returned no valid NSE EOD rows" (owner's Production run, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectTejHqEquityEvidence } from '../../api/_lib/stock-advisor-tejhq.js';

const API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));

// 60 trading days, so the indicator set (needs 50 closes) is produced too.
// Dates end today: the collector refuses an end-of-day series whose latest observation is more than 7 days old.
function payload(days = 60) {
  const rows = [];
  const firstDay = Date.now() - (days - 1) * 86400000;
  for (let i = 0; i < days; i++) {
    const d = new Date(firstDay + i * 86400000).toISOString().slice(0, 10);
    const close = 100 + i;
    rows.push({ date: d, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000 + i });
  }
  return { data: rows };
}

test('a normal TejHQ response is accepted: prices and indicators are stored, not rejected as invalid rows', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const stored = [];
  const db = { query: async (sql, params = []) => {
    if (/FROM wealth_instruments/.test(sql)) return [{ id: 'i1' }];
    if (/INSERT INTO wealth_stock_advisor_research_sources/.test(sql)) stored.push((sql.match(/'(market_price|technical_indicator)'/) || [])[1]);
    return [];
  } };
  try {
    const r = await collectTejHqEquityEvidence({ ticker: 'TCS', name: 'Tata Consultancy Services', db });
    assert.equal(r.status, 'ok', 'got: ' + (r.error || r.reason || ''));
    assert.doesNotMatch(String(r.error || ''), /no valid NSE EOD rows/);
    assert.ok(r.observations >= 50, 'every row was kept, not dropped by the date check');
    assert.deepEqual(stored, ['market_price', 'technical_indicator'], 'both evidence types the gate needs are stored');
  } finally { globalThis.fetch = originalFetch; }
});

test('a response with genuinely bad rows is still rejected, so the date check is not simply switched off', async () => {
  const originalFetch = globalThis.fetch;
  const today = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ date: 'not-a-date', open: 1, high: 1, low: 1, close: 1 }, { date: today, open: 0, high: 0, low: 0, close: 0 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const r = await collectTejHqEquityEvidence({ ticker: 'TCS', name: 'Tata Consultancy Services', db: { query: async () => [] } });
    assert.equal(r.status, 'unavailable');
    assert.match(String(r.error || ''), /no valid NSE EOD rows/);
  } finally { globalThis.fetch = originalFetch; }
});

test('no regex literal in api/ double-escapes a character class (\\\\d instead of \\d)', () => {
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.js')) continue;
      readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        // regex literals only: new RegExp('...\\d...') is a string and correctly needs the double backslash
        for (const m of line.matchAll(/\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g)) {
          if (/\\\\[dswbDSWB]/.test(m[0])) offenders.push(p.slice(API_DIR.length) + ':' + (i + 1) + '  ' + m[0].slice(0, 60));
        }
      });
    }
  })(API_DIR);
  assert.deepEqual(offenders, [], 'double-escaped regex literals never match what they look like they match');
});
