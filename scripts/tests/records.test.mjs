// Records page (2026-11-11): every wealth_snapshots record is listed (not only ones with sections), typed, searchable,
// and its stored data is shown (sections, summaries, lists as tables, notes) without internal keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = src.slice(src.indexOf('// Records page (2026-11-11)'), src.indexOf('// Activity page (2026-11-11)'));

const snapshots = [
  { id: '1', source_name: 'Angel One Equity Holdings — 10 November 2026', snapshot_date: '2026-11-10', created_at: '2026-11-10T10:00:00Z',
    payload: { source: 'Angel One app', account: 'Angel One', summary: { current_value: 125000.5, invested_value: 110000, return_pct: 13.64 },
      holdings: [{ symbol: 'TCS', quantity: 2, ltp: 4100 }, { symbol: 'INFY', quantity: 5, ltp: 1500 }], notes: ['Prices at close'], client_code: 'SECRET1' } },
  { id: '2', source_name: 'Paytm UPI statement', snapshot_date: '2024-11-10', created_at: '2026-11-11T07:00:00Z',
    payload: JSON.stringify({ kind: 'upi_statement_summary', totals: { paid: 1070611.47, paid_count: 846 },
      sections: [{ heading: 'Paytm totals', tables: [[['Account', 'Paid'], ['BOI', '₹8,22,926.03']]], notes: ['Reference only'] }] }) },
  { id: '3', source_name: 'Credit card and Roarbank screenshots — 8 November 2026', snapshot_date: '2026-11-08', created_at: '2026-11-08T10:00:00Z',
    payload: { sections: [{ heading: 'Slice card', tables: [], notes: ['Outstanding ₹30,634.21'] }] } },
  { id: '4', source_name: 'Salary PF clarification — 8 November 2026', snapshot_date: '2026-11-08', created_at: '2026-11-08T09:00:00Z',
    payload: { sections: [{ heading: 'PF', notes: ['EPF deducted monthly'] }] } },
];

function page(list = snapshots) {
  const ctx = { window: { __wealthSnapshots: list }, esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    sectionContent: s => '<div class="sec">' + (s.tables || []).flat().flat().join('|') + '|' + (s.notes || []).join('|') + '</div>',
    Number, String, Date, Math, Set, Object, JSON, Array };
  vm.runInNewContext(block + ';globalThis.api={recordsPageHtml,recordsListHtml,recordsItems,recType,recTitle,setState:s=>{recordsState={...recordsState,...s}}};', ctx);
  return ctx.api;
}

test('every record is listed, newest first, grouped by month', () => {
  const a = page(), html = a.recordsPageHtml();
  assert.match(html, /Statements &amp; records/);
  assert.match(html, /<b>4<\/b><small>records<\/small>/);
  assert.deepEqual(a.recordsItems().map(r => r.x.id), ['1', '3', '4', '2']);
  assert.match(html, /November 2026 <em>3<\/em>/);
  assert.match(html, /November 2024 <em>1<\/em>/);
});

test('types come from the record name; titles drop the trailing date', () => {
  const a = page();
  assert.deepEqual(snapshots.map(x => a.recType(x)), ['holdings', 'statement', 'screenshot', 'note']);
  assert.equal(a.recTitle(snapshots[0]), 'Angel One Equity Holdings');
  assert.equal(a.recTitle(snapshots[1]), 'Paytm UPI statement');
});

test('records without sections show their stored data: key figures, list as a table, notes', () => {
  const html = page().recordsPageHtml();
  assert.match(html, /<small>Current value<\/small><b>1,25,000\.5<\/b>/);
  assert.match(html, /<small>Return %<\/small><b>13\.64%<\/b>/);
  assert.match(html, /<th>Symbol<\/th><th>Quantity<\/th><th>Ltp<\/th>/);
  assert.match(html, /<td>TCS<\/td><td>2<\/td><td>4,100<\/td>/);
  assert.match(html, /2 holdings/);
  assert.match(html, /<li>Prices at close<\/li>/);
  assert.doesNotMatch(html, /SECRET1|Client code/, 'client code is not shown');
});

test('records with sections keep their tables and notes; JSON-string payloads are read', () => {
  const html = page().recordsPageHtml();
  assert.match(html, /<h5>Paytm totals<\/h5><div class="sec">Account\|Paid\|BOI\|₹8,22,926\.03\|Reference only<\/div>/);
  assert.match(html, /<small>Paid<\/small><b>10,70,611\.47<\/b>/);
  assert.doesNotMatch(html, /upi_statement_summary/, 'internal kind is hidden');
});

test('type chips and search filter the list', () => {
  const a = page();
  a.setState({ type: 'holdings' });
  assert.deepEqual(a.recordsItems().map(r => r.x.id), ['1']);
  a.setState({ type: 'all', q: 'epf' });
  assert.deepEqual(a.recordsItems().map(r => r.x.id), ['4']);
  a.setState({ q: 'zzz' });
  assert.match(a.recordsListHtml(a.recordsItems()), /No records match/);
  const chips = page().recordsPageHtml();
  assert.match(chips, /data-record-type="holdings" aria-pressed="false">Holdings <em>1<\/em>/);
  assert.doesNotMatch(chips, /data-record-type="report"/, 'types with no records have no chip');
});
