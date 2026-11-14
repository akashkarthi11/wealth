// Interest page (2026-11-11): FD accruals are a third series ("Fixed deposits") in the by-day chart, the daily list,
// the month total and the FD box — and never overwrite the Slice Savings value for the same day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function interestStatementFor(');
const engine = src.slice(src.indexOf('// Interactive charts (2026-11-11)'), src.indexOf('// End interactive charts'));
const block = engine + src.slice(start, src.indexOf('\n', src.indexOf('function interestViewHtml(')));

function page({ rows = [], positions = [] } = {}) {
  const ctx = { ofCall: () => '', interestRows: rows, interestStatements: [], positions, activeView: 'overview', esc: s => String(s), money: v => 'INR ' + Number(v).toFixed(2),
    Number, String, Date, Math, Set, Map, Object, JSON, Array };
  vm.runInNewContext(block + ';globalThis.api={interestDailySeries,interestSummaryHtml,activeInterestListHtml,interestViewHtml,interestSeriesKey};', ctx);
  return ctx.api;
}
const row = (product_key, accrual_date, interest_amount, revision = 1) => ({ product_key, account_key: product_key, accrual_date, interest_amount, revision });
const rows = [
  row('slice-savings', '2026-11-09', 7.2), row('slice-savings', '2026-11-10', 7.21),
  row('atom-savings', '2026-11-10', 9.55),
  row('slice-fd', '2026-11-09', 0.63720548), row('slice-fd', '2026-11-10', 0.63720548),
  row('angel-one-fd', '2026-11-09', 0.21917808), row('angel-one-fd', '2026-11-10', 0.21917808),
];

test('product keys map to series; FD keys go to "fd"', () => {
  const a = page();
  assert.equal(a.interestSeriesKey('slice-savings'), 'savings');
  assert.equal(a.interestSeriesKey('atom-savings'), 'atom');
  assert.equal(a.interestSeriesKey('slice-fd'), 'fd');
  assert.equal(a.interestSeriesKey('angel-one-fd'), 'fd');
});

test('FDs are summed per day and do not overwrite Slice Savings', () => {
  const s = page({ rows }).interestDailySeries();
  const d10 = s.find(d => d.month === '2026-11-10');
  assert.equal(d10.savings, 7.21);
  assert.equal(d10.atom, 9.55);
  assert.equal(d10.fdKnown, true);
  assert.equal(Math.round(d10.fd * 1e6) / 1e6, 0.856384);
});

test('card: month total, KPI strip, source rows that toggle chart lines, FD line and FD split', () => {
  const html = page({ rows }).interestSummaryHtml();
  assert.match(html, /<strong>INR 25\.67<\/strong>/);   // 14.41 + 9.55 + 1.71
  assert.match(html, /Nov to date · 3 sources/);
  assert.match(html, /<small>Latest day<\/small><b>INR 17\.62<\/b><span>10 Nov<\/span>/);   // 7.21 + 9.55 + 0.86
  assert.match(html, /<small>Daily average<\/small><b>INR [\d.]+<\/b><span>last 2 days<\/span>/);
  assert.match(html, /Nov projected/);
  assert.match(html, /data-chart-toggle="fd" data-chart-target="interest-day" aria-pressed="true"><i style="background:#f2b45c"><\/i><span class="int-src-name"><b>Fixed deposits<\/b><small>[^<]*Angel One FD INR 0\.44 · Slice FD INR 1\.27<\/small>/);
  assert.match(html, /<span class="int-src-amt"><b>INR 1\.71<\/b>/);
  assert.match(html, /stroke="#f2b45c"/);
  assert.doesNotMatch(html, /class="ichart-legend"/, 'source rows replace the legend');
  assert.match(html, /data-view="interest">Interest details/);
  assert.match(html, /<details class="int-how"><summary>How this is calculated/);
});

test('without FD rows the chart stays as before', () => {
  const html = page({ rows: rows.filter(r => !r.product_key.endsWith('fd')) }).interestSummaryHtml();
  assert.doesNotMatch(html, /f2b45c|Fixed deposits/);
});

test('daily list shows a Fixed deposits entry per day with a running total', () => {
  const html = page({ rows }).activeInterestListHtml();
  assert.match(html, /<small>Fixed deposits<\/small><b>INR 0\.86<\/b><em>MTD INR 1\.71/);
});

test('FD box: both FDs (incl. the screenshot-imported Angel One FD), app-reported interest and per-FD calculated interest', () => {
  const positions = [
    { record_type: 'FIXED_DEPOSIT', name: 'Slice FD', current_value: '3005.04', invested_value: '3001.00', metadata: {} },
    { record_type: 'FIXED_DEPOSIT', name: 'Angel One FD (aggregate)', current_value: '1001.30', invested_value: '1000.00', metadata: { interest_earned_inr: 1.30, historical_snapshot: true } },
  ];
  const fdRows = rows.map(r => r.product_key === 'slice-fd' ? { ...r, account_key: 'slice-fixed_deposit-slice-fd' } : r.product_key === 'angel-one-fd' ? { ...r, account_key: 'angel-one-fixed_deposit-angel-one-fd-aggregate-' } : r);
  const html = page({ rows: fdRows, positions }).interestViewHtml();
  assert.match(html, /<span>Slice FD<small>INR 3005\.04 now · INR 3001\.00 invested · app calculated INR 1\.27<\/small><\/span><b>INR 4\.04<\/b>/);
  assert.match(html, /<span>Angel One FD \(aggregate\)<small>INR 1001\.30 now · INR 1000\.00 invested · app calculated INR 0\.44<\/small><\/span><b>INR 1\.30<\/b>/);
  assert.match(html, /<strong>INR 5\.34<\/strong>/);
  assert.match(html, /calculated by this app since start INR 1\.71/);
});

test('two FDs: daily list and chart legend show the split per FD', () => {
  const a = page({ rows });
  assert.match(a.activeInterestListHtml(), /<small class="interest-fd-split">Angel One FD INR 0\.22 · Slice FD INR 0\.64<\/small>/);
  assert.match(a.interestSummaryHtml(), /Angel One FD INR 0\.44 · Slice FD INR 1\.27/);
});
