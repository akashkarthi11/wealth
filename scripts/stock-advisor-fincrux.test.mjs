import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFincruxFinancials } from '../api/_lib/stock-advisor-fincrux.js';

test('normalizes Fincrux positional array rows instead of discarding them', () => {
  const result = normalizeFincruxFinancials({
    success: 'true',
    company: 'Example Limited',
    trading_symbol: 'EXAMPLE',
    data: {
      quaterly_results: [['Mar 2026', 100, 12], ['Jun 2026', 120, 15]],
      profit_and_loss: [['FY 2026', 500, 60]],
      balance_sheet: [['FY 2026', 800, 300]],
      cash_flows: [['FY 2026', 55]],
      ratios: [['ROE', '18%']],
      top_ratios: { ROE: '18%' },
      shareholding_quarterly: [['Jun 2026', 'Promoter', '55%']],
      shareholding_yearly: [['FY 2026', 'Promoter', '55%']]
    }
  }, 'EXAMPLE');

  assert.equal(result.statement_row_count, 6);
  assert.equal(result.financials.quarterly_results.length, 2);
  assert.equal(result.financials.profit_and_loss.length, 1);
  assert.equal(result.financials.balance_sheet.length, 1);
  assert.equal(result.financials.cash_flows.length, 1);
  assert.deepEqual(result.financials.quarterly_results[0], ['Mar 2026', 100, 12]);
});

test('prefers populated misspelled Fincrux quarterly key over an empty canonical key', () => {
  const result = normalizeFincruxFinancials({
    success: true,
    trading_symbol: 'EXAMPLE',
    data: {
      quarterly_results: [],
      quaterly_results: [['Mar 2026', 100]],
      profit_and_loss: [],
      balance_sheet: [],
      cash_flows: []
    }
  }, 'EXAMPLE');
  assert.equal(result.financials.quarterly_results.length, 1);
  assert.equal(result.statement_row_count, 1);
});

test('rejects a response with no statement rows', () => {
  assert.throws(() => normalizeFincruxFinancials({
    success: 'true',
    trading_symbol: 'EXAMPLE',
    data: { quaterly_results: [], profit_and_loss: [], balance_sheet: [], cash_flows: [] }
  }, 'EXAMPLE'), /no quarterly, P&L, balance-sheet or cash-flow statement rows/);
});
