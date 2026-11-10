import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { valuePortfolio } from '../../api/_valuation.js';

const NOW = Date.now();
const iso = h => new Date(NOW - h * 3600e3).toISOString();
const model = {
  version: 'v2',
  ...valuePortfolio({
    now: NOW,
    accounts: [
      { id: 'sav', category: 'CASA', subtype: 'savings', subtype_label: 'Savings account', valuation: 'balance', institution: 'Bank <b>X</b>', name: 'Savings', currency: 'INR' },
      { id: 'demat', category: 'INVESTMENT', subtype: 'demat_equity', subtype_label: 'Stocks & ETFs (demat)', valuation: 'holdings', institution: 'Broker', name: 'Stocks', currency: 'INR' },
      { id: 'us', category: 'INVESTMENT', subtype: 'us_brokerage', subtype_label: 'US stocks & ETFs', valuation: 'holdings', institution: 'USBroker', name: 'US', currency: 'USD' },
      { id: 'cc', category: 'LIABILITY', subtype: 'credit_card', subtype_label: 'Credit card', valuation: 'balance', institution: 'Bank', name: 'Card', masked_identifier: '••2222', currency: 'INR' },
    ],
    balances: [
      { account_id: 'sav', balance: 1000, status: 'verified', as_of: iso(1) },
      { account_id: 'cc', balance: 300, status: 'reported', as_of: iso(1) },
    ],
    holdings: [
      { account_id: 'demat', instrument_id: 'lt', symbol: 'LT', name: 'Larsen', asset_class: 'indian_equity', unit: 'share', currency: 'INR', quantity: 5, price: 4185, price_source: 'Yahoo Finance', price_as_of: iso(2), fetched_at: iso(2) },
      { account_id: 'us', instrument_id: 'nvda', symbol: 'NVDA', name: 'NVIDIA', asset_class: 'us_equity', unit: 'share', currency: 'USD', quantity: 0.5, price: 160, price_source: 'Yahoo Finance', price_as_of: iso(2), fetched_at: iso(2), fx_to_inr: null },
    ],
  }),
};

function loadView() {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const start = src.indexOf('// ---- Account hierarchy view (v2)');
  const end = src.indexOf('function renderTopWealth(){');
  assert.ok(start > 0 && end > start);
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const ctx = {
    modelV2: model, wealthExpanded: null, window: { wealthCategorySymbols: {} }, Intl, Number, String, Date,
    money: n => '₹' + Number(n || 0).toFixed(2),
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    renderTopWealth: () => {},
  };
  vm.runInNewContext(src.slice(start, end) + ';globalThis.api={renderTopWealthV2,v2ExpandedHtml,setExpanded:k=>{wealthExpanded=k}};', ctx);
  return { ...ctx.api, el };
}

test('hero shows net worth from the model and flags items not counted', () => {
  const v = loadView();
  v.renderTopWealthV2(v.el);
  assert.match(v.el.innerHTML, /NET WORTH · ACCOUNT MODEL/);
  assert.match(v.el.innerHTML, new RegExp('₹' + model.totals.netWorth.toFixed(2)));
  assert.equal(model.totals.netWorth, 1000 + 20925 - 300);
  assert.match(v.el.innerHTML, /1 item not counted/);
});

test('investment details group by subtype and list the uncounted USD holding', () => {
  const v = loadView();
  const html = v.v2ExpandedHtml('investments');
  assert.match(html, /Stocks &amp; ETFs \(demat\)/);
  assert.match(html, /US stocks &amp; ETFs/);
  assert.match(html, /LT<\/b>/);
  assert.match(html, /no USD\/INR rate — not counted/);
  assert.match(html, /Not counted in the total: NVDA/);
});

test('names are HTML-escaped', () => {
  const v = loadView();
  const html = v.v2ExpandedHtml('casa');
  assert.ok(html.includes('Bank &lt;b&gt;X&lt;/b&gt;'));
  assert.ok(!html.includes('Bank <b>X</b>'));
});

test('liabilities show the card and amount owed', () => {
  const v = loadView();
  const html = v.v2ExpandedHtml('liabilities');
  assert.match(html, /Amount owed/);
  assert.match(html, /••2222/);
  assert.match(html, /₹300\.00/);
});

test('a group that cannot be valued in INR shows its USD amount, never ₹0.00', () => {
  const v = loadView();
  const html = v.v2ExpandedHtml('investments');
  const usGroup = html.split('<details').find(s => s.includes('US stocks &amp; ETFs'));
  assert.ok(usGroup, 'US group present');
  const summary = usGroup.split('</summary>')[0];
  assert.ok(!summary.includes('₹0.00'), 'group header must not show ₹0.00');
  assert.match(summary, /\$80\.00/);
  assert.match(summary, /not counted · no USD\/INR rate yet/);
});
