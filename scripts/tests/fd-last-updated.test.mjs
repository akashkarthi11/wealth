// Interest page, "Other earnings · Fixed deposits" (2026-11-15): the block and every FD in it say when they were last updated.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const line = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').split(/\r?\n/).find(l => l.startsWith('function interestViewHtml(){'));
const render = (positions, rows) => {
  const ctx = {
    positions, interestLatestLedger: () => rows, interestSeriesKey: p => (/fd/i.test(String(p)) ? 'fd' : String(p)),
    money: n => '₹' + Number(n).toFixed(2), esc: s => String(s ?? ''), ofCall: () => '', interestSummaryHtml: () => '', activeInterestListHtml: () => '',
  };
  vm.createContext(ctx); vm.runInContext(line + '\nthis.out = interestViewHtml();', ctx);
  return ctx.out;
};
const fd = (name, value, invested, asOf) => ({ record_type: 'FIXED_DEPOSIT', name, current_value: value, invested_value: invested, balance_as_of: asOf, metadata: {} });
const led = (key, date, amount) => ({ product_key: key, account_key: key, accrual_date: date, interest_amount: amount, revision: 1 });

test('each FD shows when its value was last updated and the day the app calculation runs to; the block heading shows the latest day', () => {
  const html = render(
    [fd('Angel One FD (aggregate)', 1001.3, 1000, '2026-11-11T06:00:00Z'), fd('Slice FD', 3005.04, 3001, '2026-11-12T09:30:00Z')],
    [led('angel-one-fd-aggregate', '2026-11-13', 0.22), led('angel-one-fd-aggregate', '2026-11-14', 0.22), led('slice-fd', '2026-11-14', 0.64), led('slice-fd', '2026-11-15', 0.64)]);
  assert.match(html, /Value updated 11 Nov 2026 · App calculation to 14 Nov 2026/, 'Angel One FD');
  assert.match(html, /Value updated 12 Nov 2026 · App calculation to 15 Nov 2026/, 'Slice FD');
  assert.match(html, /calculated by this app since start ₹1\.72 · last updated 15 Nov 2026/, 'heading carries the latest calculation day');
});

test('an FD with no app calculation yet still shows when its value was updated; an FD with neither date shows no date line', () => {
  const onlyValue = render([fd('Old FD', 5100, 5000, '2026-10-01T00:00:00Z')], []);
  assert.match(onlyValue, /Value updated 1 Oct 2026/);
  assert.doesNotMatch(onlyValue, /App calculation to/);
  assert.doesNotMatch(onlyValue, /last updated/, 'no app calculation, so no heading date');
  const none = render([fd('Bare FD', 5100, 5000, null)], []);
  assert.doesNotMatch(none, /interest-fd-asof/);
});

test('the date line has its own style', () => {
  assert.match(readFileSync(new URL('../../style.css', import.meta.url), 'utf8'), /\.interest-fd-asof\{/);
});
