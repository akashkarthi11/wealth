// Interactive charts (2026-11-11): Period filter, zoom window, legend toggle, gaps for missing values, labels,
// and the share-bar readout markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const engine = src.slice(src.indexOf('// Interactive charts (2026-11-11)'), src.indexOf('// End interactive charts'));
const svgLine = src.slice(src.indexOf('function svgLineChart('), src.indexOf('\n', src.indexOf('function svgLineChart(')));

function sandbox() {
  const ctx = { esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), money: v => '₹' + Number(v).toFixed(2),
    Number, String, Date, Math, Set, Map, Object, JSON, Array };
  vm.runInNewContext(engine + svgLine + ';globalThis.api={chartWidget,chartInnerHtml,chartVisible,chartLabelOf,chartRangeRowHtml,svgLineChart,CHARTS,setRange:r=>{chartRange=r}};', ctx);
  return ctx.api;
}
const ymd = d => d.toISOString().slice(0, 10);
const monthsBack = n => { const d = new Date(); d.setDate(15); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 7); };

test('Period filter scopes month series; default 1Y keeps the last 12 months; All keeps everything', () => {
  const a = sandbox();
  const series = Array.from({ length: 24 }, (_, i) => ({ month: monthsBack(23 - i), income: 100 + i, spend: 50 }));
  a.svgLineChart(series, ['income', 'spend'], ['Money in', 'Spending'], v => '₹' + v);
  const c = a.CHARTS['trend-money-in-spending'];
  assert.ok(a.chartVisible(c).n >= 12 && a.chartVisible(c).n <= 13, 'about a year of months');
  a.setRange('3m'); assert.ok(a.chartVisible(c).n <= 4);
  a.setRange('all'); assert.equal(a.chartVisible(c).n, 24);
  assert.match(a.chartRangeRowHtml(), /data-chart-range="all" aria-pressed="true">All/);
});

test('zoom keeps a window of points ending at the latest, and the toolbar enables zoom-out / reset', () => {
  const a = sandbox(); a.setRange('all');
  const pts = Array.from({ length: 20 }, (_, i) => ({ x: '2026-10-' + String(i + 1).padStart(2, '0'), values: { v: i } }));
  a.chartWidget('z', { series: [{ key: 'v', name: 'Value', color: '#78a8ff' }], points: pts, format: v => String(v), ranged: false });
  const c = a.CHARTS.z; c.span = 5; c.end = 19;
  const v = a.chartVisible(c);
  assert.deepEqual([v.pts.length, v.pts[0].x, v.pts[4].x], [5, '2026-10-16', '2026-10-20']);
  const html = a.chartInnerHtml('z');
  assert.match(html, /16 Oct – 20 Oct · drag to move/);
  assert.doesNotMatch(html, /data-chart-zoom="out" aria-label="Zoom out" disabled/);
  c.span = 1; assert.equal(a.chartVisible(c).pts.length, 2, 'never fewer than 2 points');
});

test('legend toggles series; a single series has no legend; missing values break the line', () => {
  const a = sandbox();
  const pts = [{ x: '2026-11-08', values: { a: 1, b: 2 } }, { x: '2026-11-09', values: { a: null, b: 3 } }, { x: '2026-11-10', values: { a: 2, b: 4 } }];
  a.chartWidget('t', { series: [{ key: 'a', name: 'A', color: '#111111' }, { key: 'b', name: 'B', color: '#222222' }], points: pts, format: v => String(v), ranged: false });
  let html = a.chartInnerHtml('t');
  assert.match(html, /data-chart-toggle="a" aria-pressed="true"/);
  const pathA = html.match(/<path d="([^"]+)" fill="none" stroke="#111111"/)[1];
  assert.equal((pathA.match(/M/g) || []).length, 2, 'gap on the missing day starts a new segment');
  a.CHARTS.t.hidden.add('a'); html = a.chartInnerHtml('t');
  assert.doesNotMatch(html, /stroke="#111111"/);
  assert.match(html, /data-chart-toggle="a" aria-pressed="false" class="off"/);
  a.chartWidget('one', { series: [{ key: 'a', name: 'A', color: '#111111' }], points: pts, format: String, ranged: false });
  assert.doesNotMatch(a.chartInnerHtml('one'), /ichart-legend/);
});

test('labels: year, month and day', () => {
  const a = sandbox();
  assert.equal(a.chartLabelOf('2026', true), '2026');
  assert.equal(a.chartLabelOf('2026-11', true), 'Nov 26');
  assert.equal(a.chartLabelOf('2026-11', false), 'Nov 2026');
  assert.equal(a.chartLabelOf('2026-11-05', true), '5 Nov');
  assert.equal(a.chartLabelOf('2026-11-05', false), '5 Nov 2026');
});

test('share bars carry tap-to-read data and a readout; events are bound once', () => {
  assert.equal((src.match(/data-share="'\+esc\(/g) || []).length, 3, 'investments, banks and account-splits bars');
  assert.equal((src.match(/<div class="share-readout" aria-live="polite" hidden><\/div>/g) || []).length, 3);
  assert.equal((src.match(/^chartBindEvents\(\);/gm) || []).length, 1);
  // Touched date gets a ball on every visible line; touching outside a chart / share bar closes the readout.
  assert.match(src, /ball\.setAttribute\('class','ichart-focus'\)/);
  assert.match(src, /document\.addEventListener\('pointerdown',e=>chartDismissOutside\(e\.target\),true\);/);
  assert.match(src, /function chartHide\(box\)\{[^\n]*querySelectorAll\('\.ichart-focus'\)\.forEach\(el=>el\.remove\(\)\)/);
  // Touch anywhere: a transparent full-size hit layer on every chart, plus a click fallback that shows the nearest date.
  assert.match(src, /<rect class="ichart-hit" x="0" y="0" width="'\+W\+'" height="'\+H\+'" fill="transparent" pointer-events="all"\/><\/svg>/);
  assert.match(src, /const svg=e\.target\.closest\('\.ichart svg'\);if\(svg\)\{const box=svg\.closest\('\.ichart'\);chartShow\(box,chartIndexAt\(svg,e\.clientX\)\)\}/);
  assert.match(src, /chartWidget\('interest-day',interestChartDef\(/);
  assert.match(src, /chartRangeRowHtml\(\)\+'<section class="chart-card"><div class="chart-head"><div><h4>Cash flow trend<\/h4>/);
});
