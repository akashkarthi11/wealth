// Investments page (2026-11-11): built from the holdings the dashboard counts; total equals the dashboard INVESTMENTS card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { v1Totals } from '../../api/_reconcile.js';

const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = name => { const s = src.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };
const consts = src.slice(src.indexOf('const INV_INR='), src.indexOf('function invTime('));

const now = Date.now();
const recent = new Date(now - 2 * 3600e3).toISOString(), old = new Date(now - 5 * 86400e3).toISOString();
const pos = (o) => ({ category: 'INVESTMENT', currency: 'INR', metadata: {}, invested_value: null, quantity: null, balance_as_of: '2026-11-10T10:00:00Z', ...o });
const positions = [
  pos({ name: 'Infosys', ticker: 'INFY', record_type: 'EQUITY', platform_name: 'Angel One', quantity: '10', current_value: '15200', invested_value: '14790', market_unit_price: '1520', market_price_status: 'fresh', market_price_updated_at: recent, market_price_source: 'angel' }),
  pos({ name: 'Tata Motors', ticker: 'TATAMOTORS', record_type: 'EQUITY', platform_name: 'Angel One', quantity: '5', current_value: '3400', invested_value: '4000', market_unit_price: '680', market_price_status: 'fresh', market_price_updated_at: old }),
  pos({ name: 'Nippon India Large Cap', record_type: 'MUTUAL_FUND', quantity: '29.02', current_value: '6500', invested_value: '6000' }),
  pos({ name: 'Digital gold', record_type: 'GOLD', quantity: '2.1', quantity_unit: 'g', current_value: '29416.02', invested_value: '29416.02' }),
  pos({ name: 'EPF', record_type: 'EPF', current_value: '93726', invested_value: '93726' }),
  pos({ name: 'FD 1', record_type: 'FIXED_DEPOSIT', current_value: '2002.75', invested_value: '2000.50' }),
  pos({ name: 'FD pending', record_type: 'FIXED_DEPOSIT', current_value: '9999', metadata: { reconciliation_status: 'pending_reconciliation' } }),
  pos({ name: 'Apple', ticker: 'AAPL', record_type: 'US_EQUITY', currency: 'USD', platform_name: 'INDmoney', quantity: '0.1', current_value: '23.00', invested_value: '20.00', market_unit_price: '230', market_price_status: 'fresh', market_price_updated_at: recent, market_fx_to_inr: '88', market_value_inr: '2024' }),
  pos({ name: 'Unvalued', record_type: 'EQUITY', current_value: null }),
  pos({ name: 'Card', category: 'LIABILITY', record_type: 'CREDIT_CARD', current_value: '500' }),
];
const items = [{ kind: 'investment', category: 'SIP', amount: '1000', occurred_on: '2026-11-03', account: 'HDFC' }, { kind: 'expense', category: 'Food', amount: '50', occurred_on: '2026-11-03' }];

function render() {
  const ctx = { positions, items, accounts: [], esc: s => String(s), money: v => 'INR ' + Number(v).toFixed(2), accountKey: s => s, latestAngelOneEquitySummary: null, brokerLedger: globalThis.__broker || [], window: { __wealthSnapshots: globalThis.__snaps || [] }, Number, String, Date, Math, Set, Object, JSON };
  vm.runInNewContext(consts + ['usHoldingInrValue', 'wealthPosition', 'dayChangeOf', 'istDayKey', 'dayChangeLabel', 'invTime', 'invPriceTag', 'invHolding', 'invPnlHtml', 'investmentsPageModel', 'brokerMonth', 'equityLive', 'brokerPnl', 'brokerPnlHtml', 'brokerPanelHtml', 'investmentsPageHtml'].map(fn).join('\n')
    + ';globalThis.model=investmentsPageModel();globalThis.html=investmentsPageHtml();', ctx);
  return ctx;
}

test('investments page total = dashboard INVESTMENTS (same rules as /api/reconcile v1)', () => {
  const { model, html } = render();
  const expected = v1Totals([], positions).investments;
  assert.equal(Math.round(model.total * 100) / 100, Math.round(expected * 100) / 100);
  assert.match(html, new RegExp('<div class="bank-total">INR ' + expected.toFixed(2).replace('.', '\\.') + '</div>'));
  for (const g of model.groups.filter(g => !g.snapshotOnly)) assert.equal(g.fromRows.toFixed(2), g.value.toFixed(2), 'group ' + g.id + ' rows add up to its total');
});

test('every counted holding is listed with quantity, price tag and P&L; nothing from snapshots', () => {
  const { html } = render();
  assert.match(html, /Infosys[\s\S]*10 × ₹1,520\.00[\s\S]*bank-chip ok">Live/);
  assert.match(html, /Tata Motors[\s\S]*bank-chip warn">Old price/);
  assert.match(html, /Nippon India Large Cap[\s\S]*bank-chip est">Saved value/);
  assert.match(html, /2\.1 g/, 'unit shown for grams');
  assert.match(html, /Apple[\s\S]*INR 2024\.00[\s\S]*\$23\.00/, 'US holding in INR with USD value');
  assert.match(html, /class="positive">\+INR 410\.00/, 'Infosys gain');
  assert.match(html, /class="negative">−INR 600\.00/, 'Tata Motors loss');
  assert.match(html, /Not counted \(2\): [^<]*FD pending \(pending reconciliation\)[^<]*Unvalued \(no value\)/);
  assert.doesNotMatch(html, /Card/, 'liabilities are not investments');
  assert.doesNotMatch(html, /snapshot-section|sectionHtml/);
});

test('money put in is shown separately and not added to the value', () => {
  const { html, model } = render();
  assert.match(html, /Money put in[\s\S]*1 investment transaction[\s\S]*INR 1000\.00/);
  assert.ok(!html.includes('INR ' + (model.total + 1000).toFixed(2)));
});

test('renderView uses the new page; old snapshot-based investments view removed', () => {
  assert.match(src, /else if\(view==='investments'\)\{target\.innerHTML=investmentsPageHtml\(\)\}/);
  assert.doesNotMatch(src, /RECORDED INVESTMENTS/);
});

test('Angel One ledger panel: net put in, value now (stocks + broker cash), overall gain, charges, MTF', () => {
  globalThis.__broker = [{ broker: 'angel_one', added: 369093, withdrawn: 152953, netPutIn: 216140, charges: 4400.37, chargesThisYear: 141.6, cash: -3.81, mtfBalance: 0, mtfLast: '2025-12-05',
    first: '2022-04-02', last: '2026-11-06', matchedTransfers: 3, years: [{ year: 2025, added: 50000, withdrawn: 20000, charges: 400 }, { year: 2026, added: 13882, withdrawn: 0, charges: 141.6 }] }];
  try {
    const { html, model } = render();
    const stocks = model.groups.find(g => g.id === 'equity').value;
    const gain = stocks - 3.81 - 216140;
    assert.match(html, /Angel One · since Apr 2022/);
    assert.match(html, /Net put in<\/small><b>INR 216140\.00/);
    assert.match(html, new RegExp('Value now</small><b>INR ' + (stocks - 3.81).toFixed(2).replace('.', '\.')));
    assert.match(html, new RegExp('Overall gain</small><b class="' + (gain >= 0 ? 'positive' : 'negative') + '">' + (gain >= 0 ? '\+' : '−') + 'INR ' + Math.abs(gain).toFixed(2).replace('.', '\.')));
    assert.match(html, /Broker charges<\/small><b>INR 4400\.37<\/b><em>INR 141\.60 this year/);
    assert.match(html, /MTF closed since 5 Dec 2025 · 3 bank transfers matched to the ledger/);
    assert.ok(html.indexOf('<td>2026</td>') < html.indexOf('<td>2025</td>'), 'newest year first');
  } finally { delete globalThis.__broker; }
});

test('no ledger uploaded → no panel', () => {
  const { html } = render();
  assert.doesNotMatch(html, /broker-panel/);
});

test('P&L report adds booked profit, unrealised on current stocks and the sold list to the Angel One panel', () => {
  globalThis.__broker = [{ broker: 'angel_one', added: 1000, withdrawn: 0, netPutIn: 1000, charges: 0, chargesThisYear: 0, cash: 0, mtfBalance: 0, mtfLast: null, first: '2022-04-02', last: '2026-11-06', matchedTransfers: 0, years: [] }];
  globalThis.__snaps = [{ payload: JSON.stringify({ kind: 'broker_pnl', broker: 'angel_one', period: { from: '2023-10-01', to: '2026-11-10' }, summary: { net: 24173, intradayNet: -54.49 },
    delivery: [{ symbol: 'AWL', quantity: 65, buyValue: 20584.7, sellValue: 17736.35, net: -2945.71 }, { symbol: 'VEDL', quantity: 46, buyValue: 15320.1, sellValue: 19907.4, net: 4518.4 }], intraday: [{}] }) }];
  try {
    const { html } = render();
    assert.match(html, /Booked profit \(sold\)<\/small><b class="positive">\+INR 24173\.00<\/b><em>since Oct 2023/);
    assert.match(html, /Still holding<\/small><b class="(positive|negative)">/);
    assert.match(html, /Sold stocks \(2\) · intraday −INR 54\.49/);
    assert.ok(html.indexOf('<td>VEDL</td>') < html.indexOf('<td>AWL</td>'), 'best first');
  } finally { delete globalThis.__broker; delete globalThis.__snaps; }
});
