import test from 'node:test';
import assert from 'node:assert/strict';
import { valuePortfolio, valueHolding } from '../../api/_valuation.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600e3).toISOString();
const acc = (id, category, subtype, currency = 'INR', valuation = 'balance') =>
  ({ id, category, subtype, subtype_label: subtype, valuation, institution: 'Inst', name: id, currency });
const bal = (account_id, balance, status = 'verified', h = 1) => ({ account_id, balance, status, as_of: hoursAgo(h) });
const hold = (account_id, symbol, quantity, price, extra = {}) => ({
  account_id, instrument_id: symbol, symbol, name: symbol, asset_class: 'indian_equity', unit: 'share', currency: 'INR',
  quantity, invested_value: null, price, price_as_of: hoursAgo(2), price_source: 'Yahoo Finance', fetched_at: hoursAgo(2),
  fx_to_inr: null, ...extra });

test('net worth = CASA + investments − liabilities, in paise (TR-5.3)', () => {
  const r = valuePortfolio({ now: NOW,
    accounts: [acc('sav', 'CASA', 'savings'), acc('demat', 'INVESTMENT', 'demat_equity', 'INR', 'holdings'), acc('fd', 'INVESTMENT', 'fixed_deposit'), acc('cc', 'LIABILITY', 'credit_card')],
    balances: [bal('sav', 1000.10), bal('fd', 3004.41), bal('cc', 30634.21)],
    holdings: [hold('demat', 'LT', 5, 4185), hold('demat', 'ITC', 160, 278.8)],
  });
  assert.equal(r.totals.casa, 1000.10);
  assert.equal(r.totals.investments, 20925 + 44608 + 3004.41);
  assert.equal(r.totals.liabilities, 30634.21);
  assert.equal(r.totals.netWorth, Math.round((1000.10 + 68537.41 - 30634.21) * 100) / 100);
  assert.deepEqual(r.totals.excluded, []);
});

test('USD holding converts with its own price FX, else latest market FX within 36 h', () => {
  const usd = { currency: 'USD', asset_class: 'us_equity' };
  assert.equal(valueHolding(hold('x', 'NVDA', 0.04592, 168.45, { ...usd, fx_to_inr: 88 }), { now: NOW }).valueInr, Math.round(Math.round(0.04592 * 168.45 * 100) / 100 * 88 * 100) / 100);
  const viaMarket = valueHolding(hold('x', 'QQQ', 1, 600, usd), { now: NOW, marketFx: { rate: 90, as_of: hoursAgo(5) } });
  assert.equal(viaMarket.valueInr, 54000);
  assert.equal(viaMarket.valuationStatus, 'fresh');
  const oldFx = valueHolding(hold('x', 'QQQ', 1, 600, usd), { now: NOW, marketFx: { rate: 90, as_of: hoursAgo(40) } });
  assert.equal(oldFx.valueInr, null, 'stale FX is never used');
  assert.equal(oldFx.valuationStatus, 'missing_fx');
});

test('missing FX or price is excluded and listed, never invented (TR-5.7)', () => {
  const r = valuePortfolio({ now: NOW,
    accounts: [acc('us', 'INVESTMENT', 'us_brokerage', 'USD', 'holdings')],
    balances: [bal('us', 10.02, 'reported')],
    holdings: [hold('us', 'GOOGL', 0.041299, 288.27, { currency: 'USD' }), hold('us', 'BKSY', 0.347871, null, { currency: 'USD' })],
  });
  assert.equal(r.totals.investments, 0);
  const reasons = r.totals.excluded.map(e => e.reason).sort();
  assert.deepEqual(reasons, ['missing_fx', 'missing_fx', 'missing_price']);
  assert.equal(r.accounts[0].complete, false);
});

test('pending reconciliation balances are excluded from net worth', () => {
  const r = valuePortfolio({ now: NOW, accounts: [acc('fd', 'INVESTMENT', 'fixed_deposit')], balances: [bal('fd', 3001, 'pending_reconciliation')] });
  assert.equal(r.totals.investments, 0);
  assert.deepEqual(r.totals.excluded, [{ accountId: 'fd', amount: 3001, reason: 'pending_reconciliation' }]);
});

test('price status: fresh, stale after 36 h, manual for non-refresh sources', () => {
  assert.equal(valueHolding(hold('a', 'LT', 1, 10), { now: NOW }).valuationStatus, 'fresh');
  assert.equal(valueHolding(hold('a', 'LT', 1, 10, { fetched_at: hoursAgo(40) }), { now: NOW }).valuationStatus, 'stale');
  assert.equal(valueHolding(hold('a', 'LT', 1, 10, { price_source: 'Angel One initial LTP' }), { now: NOW }).valuationStatus, 'manual');
  const stale = valuePortfolio({ now: NOW, accounts: [acc('sav', 'CASA', 'savings')], balances: [bal('sav', 5, 'verified', 72)] });
  assert.equal(stale.accounts[0].stale, true, 'a balance older than 48 h is flagged');
  assert.equal(stale.totals.casa, 5, 'stale balances are still the last known value');
});

test('November 10 regression: five US holdings, one without a price, one stale — none silently dropped', () => {
  const usd = { currency: 'USD', asset_class: 'us_equity', fx_to_inr: 88.5 };
  const holdings = [
    hold('us', 'GOOGL', 0.041299, 288.27, usd),
    hold('us', 'NVDA', 0.04592, 168.45, usd),
    hold('us', 'BKSY', 0.347871, null, usd),                          // no price yet
    hold('us', 'AVGO', 0.006264, 327.94, { ...usd, fetched_at: hoursAgo(50) }), // stale
    hold('us', 'QQQ', 0.040042, 673.32, { ...usd, asset_class: 'us_etf' }),
  ];
  const r = valuePortfolio({ now: NOW, accounts: [acc('us', 'INVESTMENT', 'us_brokerage', 'USD', 'holdings')], holdings });
  const rows = r.accounts[0].holdings;
  assert.equal(rows.length, 5, 'every holding is listed');
  assert.deepEqual(rows.map(x => x.valuationStatus), ['fresh', 'fresh', 'missing_price', 'stale', 'fresh']);
  const included = rows.filter(x => x.valueInr != null).reduce((n, x) => n + Math.round(x.valueInr * 100), 0) / 100;
  assert.equal(r.accounts[0].valueInr, included, 'account total equals the sum of its valued rows');
  assert.equal(r.totals.investments, included, 'category total equals the account total');
  assert.deepEqual(r.totals.excluded.map(e => e.symbol), ['BKSY']);
});

test('hourly-task quote sources count as live prices; broker snapshots stay manual', () => {
  for (const source of ['StockAnalysis.com real-time quote', 'ChartExchange real-time quote', 'IBJA AM benchmark 999', 'NSE', 'AMFI NAV'])
    assert.equal(valueHolding(hold('a', 'LT', 1, 10, { price_source: source }), { now: NOW }).valuationStatus, 'fresh', source);
  for (const source of ['Angel One initial LTP', 'Angel One historical snapshot', 'Paytm redemption rate'])
    assert.equal(valueHolding(hold('a', 'LT', 1, 10, { price_source: source }), { now: NOW }).valuationStatus, 'manual', source);
});
