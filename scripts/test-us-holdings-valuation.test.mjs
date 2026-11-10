import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const match = source.match(/function usHoldingInrValue\(position\)\s*\{[\s\S]*?\n\}/);
assert.ok(match, 'app.js must define the shared US holding INR valuation helper');
const context = {};
vm.runInNewContext(match[0] + '; globalThis.value = usHoldingInrValue;', context);
const value = context.value;

test('prefers the market-price INR valuation when present', () => {
  assert.equal(value({ market_value_inr: 123.45, current_value: 9, metadata: { inr_conversion: { current_value_inr: 111 } } }), 123.45);
});

test('falls back to the saved INR conversion when market INR is absent', () => {
  assert.equal(value({ market_value_inr: null, metadata: { inr_conversion: { current_value_inr: 222.5 } } }), 222.5);
});

test('converts USD current value using the available FX rate', () => {
  assert.equal(value({ current_value: 7.95, market_fx_to_inr: 93.93, metadata: {} }), 7.95 * 93.93);
});

test('uses saved FX metadata when market FX is unavailable', () => {
  assert.equal(value({ current_value: 2, metadata: { inr_conversion: { usd_inr_rate: 90 } } }), 180);
});

test('does not invent an INR value when no FX rate exists', () => {
  assert.equal(value({ current_value: 7.95, metadata: {} }), 0);
});

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const calculatorMatch = appSource.match(/function calculateWealthTotals\([\s\S]*?\n\}/);
assert.ok(calculatorMatch, 'app.js must define the canonical wealth totals calculator');
const totalsContext = {
  accountKey: value => String(value || '').toLowerCase(),
  usHoldingInrValue: position => {
    const conversion = position?.metadata?.inr_conversion || {};
    if (position?.market_value_inr != null && Number.isFinite(Number(position.market_value_inr))) return Number(position.market_value_inr);
    if (conversion.current_value_inr != null && Number.isFinite(Number(conversion.current_value_inr))) return Number(conversion.current_value_inr);
    const fx = Number(position?.market_fx_to_inr || conversion.usd_inr_rate || 0);
    return fx > 0 ? Number(position?.current_value || 0) * fx : 0;
  }
};
vm.runInNewContext(calculatorMatch[0] + '; globalThis.calculate = calculateWealthTotals;', totalsContext);
const calculate = totalsContext.calculate;

test('confirmed net worth excludes unverified retirement, pending FD and reference-FX assets without losing the reported totals', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const result = calculate({
    now,
    accountRows: [
      { bank_name: 'Atom', account_name: 'Savings', account_type: 'savings', currency: 'INR', balance_status: 'verified', current_balance: 1000, balance_as_of: '2026-11-10T00:00:00Z' },
      { bank_name: 'BOI', account_name: 'Savings', account_type: 'savings', currency: 'INR', balance_status: 'verified', current_balance: 500, balance_as_of: '2026-11-10T00:00:00Z' },
      { bank_name: 'Slice', account_name: 'Card', account_type: 'credit_card', currency: 'INR', balance_status: 'unknown', current_balance: null }
    ],
    positionRows: [
      { category: 'INVESTMENT', record_type: 'EQUITY', currency: 'INR', current_value: 1000 },
      { category: 'INVESTMENT', record_type: 'MUTUAL_FUND', currency: 'INR', current_value: 100 },
      { category: 'INVESTMENT', record_type: 'GOLD', currency: 'INR', current_value: 200 },
      { category: 'INVESTMENT', record_type: 'SILVER', currency: 'INR', current_value: 50 },
      { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: 300, metadata: {} },
      { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: 400, metadata: { reconciliation_status: 'balance_reconciliation_required' } },
      { category: 'INVESTMENT', record_type: 'EPF', currency: 'INR', current_value: 900, metadata: { warning: 'Future-dated passbook balance' } },
      { category: 'INVESTMENT', record_type: 'US_EQUITY', currency: 'USD', current_value: 10, market_value_inr: null, metadata: { inr_conversion: { current_value_inr: 800, usd_inr_rate: 80 } } },
      { category: 'INVESTMENT', record_type: 'US_PORTFOLIO_INR', currency: 'INR', current_value: 99999, metadata: { cash_balance: { buying_power_inr: 250 } } },
      { category: 'LIABILITY', record_type: 'CREDIT_CARD', currency: 'INR', current_value: 150, balance_as_of: '2026-11-10T00:00:00Z' },
      { category: 'INVESTMENT', record_type: 'EQUITY_AGGREGATE_ARCHIVED', currency: 'INR', current_value: 99000 }
    ]
  });
  assert.equal(result.casa, 1500);
  assert.equal(result.fd, 700);
  assert.equal(result.pfUnverified, 900);
  assert.equal(result.usPortfolioInr, 800);
  assert.equal(result.usCash, 250);
  assert.equal(result.investments, 3750);
  assert.equal(result.liabilities, 150);
  assert.equal(result.reportedTotal, 5350);
  assert.equal(result.unverifiedAssets, 2100);
  assert.equal(result.total, 3250);
});

test('pending-reconciliation FD and archived aggregate values are not silently treated as verified assets', () => {
  const result = calculate({
    now: Date.parse('2026-11-10T12:00:00Z'),
    accountRows: [],
    positionRows: [
      { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: 500, metadata: { reconciliation_status: 'pending_reconciliation' } },
      { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: 700, metadata: { reconciliation_status: 'balance_reconciliation_required' } },
      { category: 'INVESTMENT', record_type: 'MUTUAL_FUND_AGGREGATE_ARCHIVED', currency: 'INR', current_value: 99999 }
    ]
  });
  assert.equal(result.fd, 1200);
  assert.equal(result.pendingFd, 1200);
  assert.equal(result.total, 0);
});
