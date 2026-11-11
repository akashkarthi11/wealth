// Activity page (2026-11-11): period totals, month/day groups, safe delete, paging, filters kept across re-render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = src.slice(src.indexOf('// Activity page (2026-11-11)'), src.indexOf('function renderView('));

const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const today = new Date(), d = n => { const x = new Date(); x.setDate(x.getDate() - n); return ymd(x); };
const tx = (id, kind, amount, date, o = {}) => ({ id, kind, amount: String(amount), occurred_on: date, category: 'Cat', description: 'Item ' + id, account: 'HDFC Savings', account_id: 'a1', ...o });

function page(items, { txCursor = null } = {}) {
  const els = {};
  const el = (id, value = '') => (els[id] = { id, value, textContent: '', innerHTML: '', hidden: false, classList: { toggle() {} } });
  const ctx = { items, txCursor, transactionTotalCount: () => items.length, lendActivityButtonHtml: () => '', lendRowTag: () => '', lendHiddenTx: () => false, esc: s => String(s), money: v => 'INR ' + Number(v).toFixed(2), Number, String, Date, Math, Set, Object, JSON,
    $: id => els[id], document: { querySelectorAll: () => [] } };
  vm.runInNewContext(block + ';globalThis.api={activityRowsHtml,activitiesHtml,activityPresetRange,activityPeriod,actFlows,state:()=>activityState,setState:s=>{activityState=s}};', ctx);
  const mount = () => { const html = ctx.api.activitiesHtml();
    const val = (id) => { const m = html.match(new RegExp('id="' + id + '"[^>]*value="([^"]*)"')); return m ? m[1] : ''; };
    const sel = (id) => { const m = html.match(new RegExp('<select id="' + id + '">([\\s\\S]*?)</select>')); const s = m && m[1].match(/value="([^"]*)" selected/); return s ? s[1] : 'all'; };
    ['activitySearch', 'activityFrom', 'activityTo'].forEach(id => el(id, val(id))); ['activityKind', 'activityAccount'].forEach(id => el(id, sel(id)));
    ['activityCount', 'activityFilterBadge', 'activityActiveFilters', 'activityClearAll', 'activitySummary', 'activityRows'].forEach(id => el(id));
    ctx.api.activityRowsHtml(); return html; };
  return { ctx, els, mount };
}

test('opens on this month with in / out / net / transfers totals', () => {
  const items = [tx(1, 'income', 50000, ymd(today)), tx(2, 'expense', 1200, ymd(today)), tx(3, 'transfer', 5000, ymd(today)), tx(4, 'investment', 1000, ymd(today)), tx(5, 'liability', 300, ymd(today)),
    tx(6, 'expense', 999, '2020-01-05')];
  const { els, mount } = page(items); mount();
  assert.equal(els.activityFrom.value, ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
  const s = els.activitySummary.innerHTML;
  assert.match(s, /Money in<\/small><b>\+INR 50000\.00/);
  assert.match(s, /Money out<\/small><b>−INR 2500\.00<\/b><em>incl\. investments INR 1000\.00 · card payments INR 300\.00/);
  assert.match(s, /Net · This month<\/small><b>\+INR 47500\.00/);
  assert.match(s, /Transfers<\/small><b>INR 5000\.00/);
  assert.match(els.activityCount.textContent, /^5 of 6/);
  assert.doesNotMatch(els.activityRows.innerHTML, /Item 6/, '2020 row outside this month');
});

test('rows: readable day and month headings, signed amounts, delete only inside the opened row', () => {
  const items = [tx(1, 'expense', 120, ymd(today)), tx(2, 'income', 900, d(1)), tx(3, 'expense', 40, d(1), { account_id: null, account: 'Unassigned' })];
  const { els, mount } = page(items); mount();
  const h = els.activityRows.innerHTML;
  assert.match(h, /act-day-head"><span>Today</);
  if (d(1).slice(0, 7) === ymd(today).slice(0, 7)) assert.match(h, /act-day-head"><span>Yesterday</);
  assert.match(h, /act-month-head"><b>[A-Z][a-z]+ \d{4}<\/b>/);
  assert.match(h, /act-amt out">−INR 120\.00/);
  assert.match(h, /act-amt in">\+INR 900\.00/);
  assert.match(h, /act-noacct">No account/);
  const summaries = h.match(/<summary>[\s\S]*?<\/summary>/g);
  assert.ok(summaries.every(s => !/delete/.test(s)), 'no delete button on the collapsed row');
  assert.equal((h.match(/class="delete act-delete" data-id="/g) || []).length, 3, 'delete is inside each expanded panel');
});

test('No account filter, search, all time, and paging by 60', () => {
  const items = Array.from({ length: 130 }, (_, i) => tx(i, 'expense', 10, '2025-0' + (1 + (i % 9)) + '-10', i < 4 ? { account_id: null, account: 'Unassigned' } : {}));
  const { ctx, els, mount } = page(items); mount();
  els.activityFrom.value = ''; els.activityTo.value = ''; ctx.api.activityRowsHtml();
  assert.equal(ctx.api.activityPeriod('', ''), 'all');
  assert.equal((els.activityRows.innerHTML.match(/<details class="act-row">/g) || []).length, 60);
  assert.match(els.activityRows.innerHTML, /Show more · 70 left/);
  ctx.api.setState({ ...ctx.api.state(), shown: 120 }); ctx.api.activityRowsHtml();
  assert.equal((els.activityRows.innerHTML.match(/<details class="act-row">/g) || []).length, 120);
  els.activityAccount.value = '__none'; ctx.api.activityRowsHtml();
  assert.equal((els.activityRows.innerHTML.match(/<details class="act-row">/g) || []).length, 4, 'only rows without an account');
  assert.match(els.activityActiveFilters.innerHTML, /No account/);
});

test('filters survive a re-render (older transactions loading in the background)', () => {
  const items = [tx(1, 'expense', 10, '2025-03-01'), tx(2, 'income', 20, '2025-03-02')];
  const { ctx, els, mount } = page(items); mount();
  els.activitySearch.value = 'item 2'; els.activityKind.value = 'income'; els.activityFrom.value = ''; els.activityTo.value = ''; ctx.api.activityRowsHtml();
  const html = mount();
  assert.match(html, /id="activitySearch"[^>]*value="item 2"/);
  assert.match(html, /value="income" selected/);
  assert.equal(els.activityFrom.value, '', 'all time kept, not reset to this month');
  assert.match(els.activityRows.innerHTML, /Item 2/); assert.doesNotMatch(els.activityRows.innerHTML, /Item 1/);
});

test('period presets use local dates (no UTC off-by-one)', () => {
  const { ctx } = page([]);
  const [f, t] = ctx.api.activityPresetRange('lastmonth');
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1), last = new Date(today.getFullYear(), today.getMonth(), 0);
  assert.equal(JSON.stringify([f, t]), JSON.stringify([ymd(first), ymd(last)]));
  assert.equal(JSON.stringify(ctx.api.activityPresetRange('today')), JSON.stringify([ymd(today), ymd(today)]));
});
