// Five Fincrux requests were spent on 23 Nov and we still could not say what the response contained. Every outside
// call now records its shape, so one request answers "which data do we actually get" — and never leaks a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { safeEndpoint, describeShape, sampleOf, recordApiCall } from '../../api/_lib/api-audit.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('the API key never reaches the audit, whatever the URL looks like', () => {
  assert.equal(safeEndpoint('https://api.fincrux.org/api/financials/BEL?api_key=s3cret'),
    'https://api.fincrux.org/api/financials/BEL?api_key=REDACTED');
  assert.match(safeEndpoint('https://x.test/a?token=abc&from=2026-01-01'), /token=REDACTED/);
  assert.match(safeEndpoint('https://x.test/a?token=abc&from=2026-01-01'), /from=2026-01-01/, 'ordinary parameters are kept');
  assert.doesNotMatch(safeEndpoint('not a url?apikey=abc'), /abc/, 'even an unparseable URL is redacted');
  assert.match(safeEndpoint('https://api.tejhq.dev/v1/ohlcv/nse/TCS?from=2026-01-01'), /ohlcv\/nse\/TCS/, 'a URL with no secret is unchanged');
});

test('the shape says how many rows each field held — the answer to "what did we get"', () => {
  // exactly the Fincrux case: statements present but empty, ratios populated
  const shape = describeShape({ about: 'Defence electronics.', ratios: [{ name: 'ROE' }, { name: 'PE' }],
    top_ratios: { pe: '42' }, profit_and_loss: [], balance_sheet: [], cash_flows: [], quarterly_results: [] });
  assert.equal(shape.ratios, 2);
  assert.equal(shape.profit_and_loss, 0, 'an empty array reads as 0, not as missing');
  assert.equal(shape.quarterly_results, 0);
  assert.equal(shape.top_ratios, 'object(1)');
  assert.match(String(shape.about), /^text\(/);
  assert.deepEqual(describeShape(null), {});
  assert.deepEqual(describeShape([1, 2]), {}, 'an array at the top level is not a field map');
});

test('the sample keeps one row per field and stays small', () => {
  const s = sampleOf({ quarterly_results: [{ quarter: 'Q2 FY27', sales: '100' }, { quarter: 'Q1 FY27' }], about: 'short text', pe: 42 });
  assert.deepEqual(s.quarterly_results, { quarter: 'Q2 FY27', sales: '100' }, 'the first row shows the real field names');
  assert.equal(s.about, 'short text');
  assert.equal(s.pe, 42);
  const huge = sampleOf({ rows: [{ blob: 'x'.repeat(5000) }] });
  assert.ok(JSON.stringify(huge).length < 500, 'an oversized sample is replaced by a note');
});

test('a recorded call is readable afterwards, and a failed audit never breaks the caller', async () => {
  const { a } = await migratedDb();
  await recordApiCall(a, { provider: 'Fincrux', endpoint: 'https://api.fincrux.org/api/financials/BEL?api_key=s3cret',
    ticker: 'bel', httpStatus: 200, ok: true, usable: false, durationMs: 812, bytes: 3400,
    payload: { success: true, trading_symbol: 'BEL', data: { about: 'x', ratios: [{ n: 1 }], profit_and_loss: [], quarterly_results: [] } } });
  const [row] = await a.query(`SELECT * FROM wealth_api_audit WHERE provider='Fincrux'`);
  assert.equal(row.ticker, 'BEL', 'stored uppercase for lookups');
  assert.equal(row.usable, false);
  assert.doesNotMatch(row.endpoint, /s3cret/);
  assert.deepEqual(row.response_keys.sort(), ['data', 'success', 'trading_symbol']);
  assert.ok(row.data_keys.includes('quarterly_results'));
  const counts = typeof row.section_counts === 'string' ? JSON.parse(row.section_counts) : row.section_counts;
  assert.equal(counts.profit_and_loss, 0);
  assert.equal(counts.ratios, 1);

  // a broken database must not take the collection down with it
  await recordApiCall({ query: async () => { throw new Error('db down'); } }, { provider: 'X', endpoint: 'https://x.test' });
});

test('wiring: the providers record their calls and the page shows the shape', () => {
  const fincrux = read('api/_lib/stock-advisor-fincrux.js');
  assert.match(fincrux, /import \{ recordApiCall \} from '\.\/api-audit\.js'/);
  assert.ok((fincrux.match(/recordApiCall\(/g) || []).length >= 3, 'the response, the failure and the stored snapshot are all recorded');
  assert.match(read('api/_lib/stock-advisor-tejhq.js'), /recordApiCall\(db, \{ provider: SOURCE/);
  assert.match(read('api/_routes/api-usage.js'), /FROM wealth_api_audit/);
  assert.match(read('app.js'), /function auAudit\(a\)/);
  assert.match(read('app.js'), /Came back empty/, 'fields that returned nothing are called out');
  assert.match(read('scripts/migrations/0049_api_audit.sql'), /CREATE TABLE IF NOT EXISTS wealth_api_audit/);
  assert.ok(read('api/_lib/api-audit.js').includes("WITH actor AS MATERIALIZED (SELECT set_config('wealth.actor', 'agent', true))"),
    'the audit insert sets the required actor in the same write statement');
});
