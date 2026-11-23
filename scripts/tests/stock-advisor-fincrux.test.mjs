import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFincruxFinancials } from '../../api/_lib/stock-advisor-fincrux.js';

test('normalizes Fincrux quarterly results and statements for the requested ticker', () => {
  const result = normalizeFincruxFinancials({
    success: 'true',
    company: 'Example Industries Limited',
    trading_symbol: 'EXAMPLE',
    data: {
      last_updated_at: '2026-10-31T00:00:00Z',
      quarterly_results: [{ quarter: 'Q2 FY27', revenue: '100' }],
      profit_and_loss: [{ year: '2026', revenue: '500' }],
      balance_sheet: [{ year: '2026', total_assets: '800' }],
      cash_flows: [{ year: '2026', operating_cash_flow: '70' }]
    }
  }, 'EXAMPLE');
  assert.equal(result.ticker, 'EXAMPLE');
  assert.equal(result.statement_row_count, 4);
  assert.equal(result.financials.quarterly_results.length, 1);
  assert.equal(result.last_updated_at, '2026-10-31T00:00:00.000Z');
});

test('supports the provider quarterly_results spelling and legacy quaterly_results spelling', () => {
  const result = normalizeFincruxFinancials({
    success: true,
    trading_symbol: 'TEST',
    data: { quaterly_results: [{ quarter: 'Q1' }] }
  }, 'TEST');
  assert.equal(result.financials.quarterly_results.length, 1);
});

test('rejects a ticker mismatch rather than storing another company financials', () => {
  assert.throws(() => normalizeFincruxFinancials({
    success: true,
    trading_symbol: 'OTHER',
    data: { quarterly_results: [{ quarter: 'Q1' }] }
  }, 'TEST'), /symbol mismatch/i);
});

test('rejects empty or non-statement responses', () => {
  assert.throws(() => normalizeFincruxFinancials({
    success: true,
    trading_symbol: 'TEST',
    data: { about: 'Company description', top_ratios: { ROE: '10%' } }
  }, 'TEST'), /no quarterly/i);
});

test('rejects unsuccessful provider responses', () => {
  assert.throws(() => normalizeFincruxFinancials({
    success: false,
    trading_symbol: 'TEST',
    data: { quarterly_results: [{ quarter: 'Q1' }] }
  }, 'TEST'), /did not confirm/i);
});
