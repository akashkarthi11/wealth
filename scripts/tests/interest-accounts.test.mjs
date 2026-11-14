// Interest set up by the owner (migration 0033, 2026-11-14): add a savings account with its rate per year and how often the interest is
// paid (daily, monthly, every 2 months, quarterly ...). The nightly run works the interest out, lists it, and adds it to the balance
// when it is paid: daily = one "interest this month" row updated every night; periodic = one row per period, on the day it is paid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { addMonthsISO, creditPeriods, periodHolding, planAccrual, runAccrual, saveInterestAccount, interestOverview } from '../../api/_interest.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');     // through = 2026-11-13 (yesterday IST)
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

async function setup({ balance = 100000, asOf = '2026-09-30T18:30:00Z' } = {}) {      // 1 Oct 2026 00:00 IST
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const acc = (await createAccount(u.id, { subtype: 'savings', institution: 'HDFC Bank', name: 'HDFC Savings' }, { db: a })).account.id;
  if (balance != null) await recordBalance(u.id, { accountId: acc, balance, asOf, status: 'verified' }, { db: a, now: NOW });
  const interestRows = () => a.query(`SELECT external_ref, amount::float8 AS amount, occurred_on::text AS day, review_status FROM wealth_transactions WHERE user_id=$1 AND category='Interest' ORDER BY occurred_on`, [u.id]);
  const latest = async () => (await a.query(`SELECT balance::float8 AS b, status, as_of FROM wealth_v_latest_balances WHERE account_id=$1`, [acc]))[0];
  return { a, uid: u.id, other: o.id, acc, interestRows, latest };
}
const r2 = x => Math.round(x * 100) / 100;

test('periods: months are added on the calendar, cut to the month end; periods every N months from the start', () => {
  assert.equal(addMonthsISO('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsISO('2026-11-01', 2), '2027-01-01');
  assert.equal(addMonthsISO('2026-12-15', -12), '2025-12-15');
  assert.deepEqual(creditPeriods('2026-09-01', 2, '2026-11-13'), [{ start: '2026-09-01', end: '2026-10-31' }]);
  assert.deepEqual(creditPeriods('2026-10-01', 1, '2026-11-13').map(p => p.end), ['2026-10-31']);
  assert.deepEqual(creditPeriods('2026-01-01', 3, '2026-12-31').map(p => p.end), ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']);
  assert.deepEqual(periodHolding('2026-09-01', 2, '2026-11-14'), { start: '2026-11-01', end: '2026-12-31' });
  assert.equal(periodHolding('2026-12-01', 1, '2026-11-14'), null, 'before the first period');
});

test('paid monthly: interest every day, one interest row at the month end, the balance goes up then, and the next month earns on it', async () => {
  const { a, uid, acc, interestRows, latest } = await setup();
  const r = await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 6, creditFrequency: 'monthly', creditAnchor: '2026-10-01' }, { db: a, now: NOW });
  assert.equal(r.created, true);
  const daily = 100000 * 0.06 / 365, octTotal = r2(daily * 31);
  const rows = await interestRows();
  assert.deepEqual(rows.map(x => [x.day, x.amount, x.review_status]), [['2026-10-31', octTotal, null]], 'one row for October, never waiting for review');
  assert.match(rows[0].external_ref, /^interest-credit:my-/);
  const bal = await latest();
  assert.deepEqual([bal.b, bal.status], [r2(100000 + octTotal), 'estimated'], 'the balance includes the interest paid');
  const nov = await a.query(`SELECT principal::float8 AS p FROM wealth_interest_ledger WHERE accrual_date='2026-11-05'`);
  assert.equal(nov[0].p, r2(100000 + octTotal), 'November earns on the balance including October interest');
  const ov = await interestOverview(uid, { db: a, now: NOW });
  const s = ov.sources.find(x => x.account_id === acc);
  assert.deepEqual([s.credit_frequency, s.next_credit, s.own, s.rate], ['monthly', '2026-11-30', true, 0.06]);
  assert.equal(s.period_accrued, r2(13 * r2(100000 + octTotal) * 0.06 / 365 * 1), 'November so far');
  assert.ok(ov.history.some(h => h.amount === octTotal));
  // running again changes nothing
  await runAccrual(uid, { db: a, now: NOW });
  assert.equal((await interestRows()).length, 1);
});

test('paid every 2 months: September and October are paid together on 31 Oct; next payment 31 Dec', async () => {
  const { a, uid, acc, interestRows } = await setup({ asOf: '2026-08-31T18:30:00Z' });
  await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 7.3, creditFrequency: 'bimonthly', creditAnchor: '2026-09-01' }, { db: a, now: NOW });
  const rows = await interestRows();
  assert.deepEqual(rows.map(x => x.day), ['2026-10-31']);
  assert.equal(rows[0].amount, r2(100000 * 0.073 / 365 * 61), '61 days at 7.3% on 1,00,000');
  assert.equal((await interestOverview(uid, { db: a, now: NOW })).sources[0].next_credit, '2026-12-31');
});

test('paid daily: the same "interest this month" row is updated every night, and the balance goes up every day', async () => {
  const { a, uid, acc, interestRows, latest } = await setup({ asOf: '2026-10-31T18:30:00Z' });   // 1 Nov
  await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 5, creditFrequency: 'daily' }, { db: a, now: NOW });
  let rows = await interestRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0].external_ref, /^interest-month:my-.*:2026-11$/);
  assert.equal(rows[0].review_status, null);
  const first = rows[0].amount;
  await runAccrual(uid, { db: a, now: NOW + 864e5 });      // next night
  rows = await interestRows();
  assert.equal(rows.length, 1, 'still one row for the month');
  assert.ok(rows[0].amount > first, 'the same row grew');
  assert.equal((await latest()).status, 'estimated');
  assert.ok((await latest()).b > 100000);
});

test('a new rate starts on its date; days after it are worked out again at the new rate; nothing before changes', async () => {
  const { a, uid, acc } = await setup();
  await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 6, creditFrequency: 'monthly', creditAnchor: '2026-10-01' }, { db: a, now: NOW });
  const before = (await a.query(`SELECT coalesce(sum(interest_amount),0)::float8 AS s FROM wealth_interest_ledger WHERE accrual_date < '2026-11-10'`))[0].s;
  const r = await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 7, creditFrequency: 'monthly', creditAnchor: '2026-10-01', effectiveFrom: '2026-11-10' }, { db: a, now: NOW });
  assert.deepEqual([r.rateChange.from, r.rateChange.ratePercent, r.rateChange.previousPercent], ['2026-11-10', 7, 6]);
  const rates = await a.query(`SELECT annual_rate::float8 AS r, effective_from::text AS f, effective_to::text AS t FROM wealth_interest_rates ORDER BY effective_from`);
  assert.deepEqual(rates.map(x => [x.r, x.t]), [[0.06, '2026-11-09'], [0.07, null]]);
  const after = (await a.query(`SELECT coalesce(sum(interest_amount),0)::float8 AS s FROM wealth_interest_ledger WHERE accrual_date < '2026-11-10'`))[0].s;
  assert.equal(after, before, 'days before the new rate are unchanged');
  const day = (await a.query(`SELECT sum(interest_amount)::float8 AS s FROM wealth_interest_ledger WHERE accrual_date = '2026-11-12'`))[0].s;
  assert.ok(Math.abs(day - r2(100000 + r2(100000 * 0.06 / 365 * 31)) * 0.07 / 365) < 1e-6, 'a day after the change is at 7%');
  await assert.rejects(saveInterestAccount(uid, { accountId: acc, annualRatePercent: 8, creditFrequency: 'monthly', creditAnchor: '2026-10-01', effectiveFrom: '2026-11-01' }, { db: a, now: NOW }), e => e.status === 409, 'must start after the current rate');
});

test('rules: savings and current only, own accounts only, a sensible rate and way of paying; a catalogue account keeps its rate', async () => {
  const { a, uid, other, acc } = await setup();
  const fd = (await createAccount(uid, { subtype: 'fixed_deposit', institution: 'HDFC Bank', name: 'FD' }, { db: a })).account.id;
  const ok = { accountId: acc, annualRatePercent: 6, creditFrequency: 'monthly' };
  for (const bad of [{ accountId: fd }, { creditFrequency: 'weekly' }, { creditFrequency: 'on_maturity' }, { annualRatePercent: 0 }, { annualRatePercent: 150 }, { creditAnchor: 'soon' }, { accountId: 'x' }, { balanceMaxAgeDays: 500 }])
    await assert.rejects(saveInterestAccount(uid, { ...ok, ...bad }, { db: a, now: NOW }), e => e.status === 400, JSON.stringify(bad));
  await assert.rejects(saveInterestAccount(other, ok, { db: a, now: NOW }), e => e.status === 404, "another user's account");
  await assert.rejects(saveInterestAccount(uid, { ...ok, annualRatePercent: undefined }, { db: a, now: NOW }), e => e.status === 400, 'a new account needs its rate');
  // a catalogue product (shared): its rate cannot be changed here, how it is paid can
  const slice = (await createAccount(uid, { subtype: 'savings', institution: 'Slice', name: 'Slice Savings' }, { db: a })).account.id;
  await a.query(`INSERT INTO wealth_interest_products (product_key, provider, credit_frequency) VALUES ('slice-savings-test', 'Slice', 'daily')`);
  await a.query(`INSERT INTO wealth_interest_links (account_id, product_id) SELECT $1, id FROM wealth_interest_products WHERE product_key='slice-savings-test'`, [slice]);
  await assert.rejects(saveInterestAccount(uid, { accountId: slice, annualRatePercent: 9, creditFrequency: 'daily' }, { db: a, now: NOW }), e => e.status === 409);
  const r = await saveInterestAccount(uid, { accountId: slice, creditFrequency: 'monthly', creditAnchor: '2026-11-01' }, { db: a, now: NOW });
  assert.equal(r.created, false);
  const [l] = await a.query(`SELECT credit_frequency, credit_anchor::text AS anchor FROM wealth_interest_links WHERE account_id=$1`, [slice]);
  assert.deepEqual([l.credit_frequency, l.anchor], ['monthly', '2026-11-01']);
  assert.equal((await a.query(`SELECT credit_frequency FROM wealth_interest_products WHERE product_key='slice-savings-test'`))[0].credit_frequency, 'daily', 'the shared product is untouched');
});

test('pause stops the nightly work for that account; the list shows it as paused', async () => {
  const { a, uid, acc, interestRows } = await setup();
  await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 6, creditFrequency: 'monthly', creditAnchor: '2026-10-01', paused: true }, { db: a, now: NOW });
  assert.equal((await interestRows()).length, 0);
  const run = await runAccrual(uid, { db: a, now: NOW });
  assert.equal(run.accounts.find(x => x.status === 'paused').rowsWritten, 0);
  assert.equal((await interestOverview(uid, { db: a, now: NOW })).sources[0].paused, true);
});

test('an own account uses a balance up to 60 days old; catalogue products keep the 2-day rule', () => {
  const balances = [{ as_of: '2026-10-01T00:00:00Z', balance: 1000, status: 'verified' }];
  const rates = [{ id: 'r', annual_rate: 0.0365, effective_from: '2026-01-01', effective_to: null }];
  const strict = planAccrual({ kind: 'savings', balances, rates, through: '2026-10-10' });
  const lenient = planAccrual({ kind: 'savings', balances, rates, through: '2026-10-10', maxAgeDays: 60 });
  assert.ok(strict.rows.length <= 3 && strict.skipped.some(s => s.reason === 'stale balance'));
  assert.equal(lenient.rows.length, 10);
});

test('wiring: route, router, nightly runs every user, migration is additive and fixes interest rows left waiting for review', () => {
  assert.match(read('api/_routes/interest.js'), /'interest\/accounts': \{ user: true, ingest: false \}/);
  assert.match(read('api/router.js'), /'interest\/accounts': \(\) => import/);
  const n = read('api/_routes/nightly.js');
  assert.match(n, /SELECT DISTINCT a\.user_id FROM wealth_interest_links/);
  const m = read('scripts/migrations/0033_interest_accounts.sql');
  assert.doesNotMatch(m, /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM|DROP COLUMN/i);
  assert.match(m, /'bimonthly'/);
  assert.match(m, /UPDATE wealth_transactions SET review_status = NULL/);
  const i = read('api/_interest.js');
  assert.equal((i.match(/external_ref, review_status\)/g) || []).length, 4, 'every interest row the app writes is not waiting for review');
});

// ---- the Interest page screens (interest.js) ----
import vm from 'node:vm';
function loadUi() {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const ctx = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]), money: v => 'Rs' + Number(v).toFixed(2), api: async () => ({}), alert() {}, confirm: () => true,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } }, Number, String, Date, Math, Object, JSON, Array, Set, Intl, console, setTimeout };
  vm.createContext(ctx); vm.runInContext(read('interest.js'), ctx); return ctx;
}
test('the Interest list shows the rate, how it is paid, what this period has earned and when it is paid; everything is escaped', () => {
  const c = loadUi(), evil = '<img src=x onerror=alert(1)>';
  const html = c.inSourcesHtml({ today: '2026-11-14', sources: [
    { account_id: 'a', bank_name: 'HDFC Bank', account_name: evil, subtype_code: 'savings', rate: 0.065, rate_from: '2026-08-16', own: true, credit_frequency: 'bimonthly', next_credit: '2026-12-31', period: { start: '2026-11-01', end: '2026-12-31' }, period_accrued: 120.5, accrued_month: 80, credited_total: 500, balance: 100000, balance_as_of: '2026-11-10T00:00:00Z', last_accrual: '2026-11-13', max_age_days: 60 },
    { account_id: 'b', bank_name: 'Slice', account_name: 'Slice Savings', subtype_code: 'savings', rate: 0.055, own: false, credit_frequency: 'daily', accrued_month: 25.53, credited_total: 25.53, max_age_days: 2, paused: true }],
    unlinked: [{ id: 'c', bank_name: 'BOI', account_name: 'BOI Savings', subtype_code: 'savings' }], history: [{ account: evil, description: evil, amount: 10, occurred_on: '2026-10-31' }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /6\.5% a year · paid every 2 months/);
  assert.match(html, /This period so far <b>₹120\.50<\/b> · paid on <b>31 Dec 2026<\/b>/);
  assert.match(html, /5\.5% a year · bank rate · paid daily/);
  assert.match(html, /Paused/);
  assert.match(html, /data-in-add data-in-account="c"/, 'not-yet-set-up accounts can be added in one tap');
  assert.match(c.inToolbarHtml(), /data-in-add/);
  assert.equal(c.inSourcesHtml({ sources: [], unlinked: [], history: [] }).includes('No account earns interest here yet'), true);
});
test('wiring: interest.js loads after offers.js, is checked and published, and the Interest page has the Add button at the top', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('/offers.js') < html.indexOf('/interest.js'));
  assert.match(read('scripts/validate-homepage.mjs'), /const SCRIPTS = \['app\.js', 'offers\.js', 'interest\.js'\]/);
  const app = read('app.js');
  assert.ok(app.includes("ofCall('inToolbarHtml')") && app.includes("ofCall('inSourcesHtml',d)"));
  const top = s => new Set([...s.matchAll(/^(?:const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  const mine = top(read('interest.js')), others = new Set([...top(app.replace(/\r\n/g, '\n')), ...top(read('offers.js').replace(/\r\n/g, '\n'))]);
  assert.deepEqual([...mine].filter(n => others.has(n)), [], 'no name defined twice across the scripts');
});

test('lists show 10 rows a page with Newer / Older buttons', () => {
  const c = loadUi();
  const history = Array.from({ length: 25 }, (_, i) => ({ account: 'HDFC', description: 'Interest ' + i, amount: i + 1, occurred_on: '2026-10-' + String(i + 1).padStart(2, '0') }));
  const html = c.inSourcesHtml({ sources: [], unlinked: [], history });
  assert.equal((html.match(/class="in-hist-row"/g) || []).length, 10);
  assert.match(html, /1–10 of 25 · page 1 of 3/);
  assert.match(html, /data-in-page="hist" data-in-to="-1" disabled>‹ Newer/);
  const p = c.inPager('daily', 9);
  assert.deepEqual([p.from, p.to, p.html], [0, 9, ''], 'no buttons when everything fits on one page');
  assert.match(read('interest.js'), /function inDailyListInner\(\)[\s\S]*inPager\('daily'/);
});

test('daily, a new entry every day: one row per day; switching to one entry per month never counts twice and can switch back', async () => {
  const { a, uid, acc, interestRows } = await setup({ asOf: '2026-10-31T18:30:00Z' });   // 1 Nov
  await saveInterestAccount(uid, { accountId: acc, annualRatePercent: 5, creditFrequency: 'daily', recordMode: 'day' }, { db: a, now: NOW });
  let rows = await interestRows();
  assert.equal(rows.length, 13, '1 to 13 November, one row each');
  assert.ok(rows.every(x => /^interest-day:my-.*:2026-11-\d\d$/.test(x.external_ref) && x.review_status === null));
  assert.deepEqual([rows[0].day, rows[12].day], ['2026-11-01', '2026-11-13']);
  const counted = async () => (await a.query(`SELECT external_ref FROM wealth_transactions WHERE user_id=$1 AND category='Interest' AND duplicate_of IS NULL`, [uid])).map(x => x.external_ref);
  const dayTotal = r2(rows.reduce((n, x) => n + x.amount, 0));
  // switch to one entry per month: the month row is written, the day rows are kept but no longer counted
  await saveInterestAccount(uid, { accountId: acc, creditFrequency: 'daily', recordMode: 'month' }, { db: a, now: NOW });
  let live = await counted();
  assert.equal(live.length, 1);
  assert.match(live[0], /^interest-month:/);
  const month = (await interestRows()).find(x => x.external_ref.startsWith('interest-month:'));
  assert.ok(Math.abs(month.amount - dayTotal) <= 0.07, 'same money either way (rounding per day aside)');
  // and back: day rows count again, the month row does not
  await saveInterestAccount(uid, { accountId: acc, creditFrequency: 'daily', recordMode: 'day' }, { db: a, now: NOW });
  live = await counted();
  assert.equal(live.length, 13);
  assert.ok(live.every(r => r.startsWith('interest-day:')));
  const ov = await interestOverview(uid, { db: a, now: NOW });
  assert.equal(ov.sources.find(x => x.account_id === acc).record_mode, 'day');
  await assert.rejects(saveInterestAccount(uid, { accountId: acc, creditFrequency: 'daily', recordMode: 'week' }, { db: a, now: NOW }));
});

test('the add sheet: choice cards for how it is paid; daily shows the two ways it can appear, with a preview of each', () => {
  const c = loadUi(), box = { innerHTML: '', querySelector: () => null };
  c.$ = () => box;
  vm.runInContext(`inData = { today: '2026-11-14', ownMaxAgeDays: 60, sources: [], unlinked: [{ id: 'h', bank_name: 'HDFC Bank', account_name: 'HDFC Savings', subtype_code: 'savings' }], history: [] };`, c);
  vm.runInContext(`inOpen('h')`, c);
  assert.match(box.innerHTML, /role="radiogroup" aria-label="When the bank pays the interest"/);
  assert.equal((box.innerHTML.match(/data-in-freq="/g) || []).length, 6);
  assert.match(box.innerHTML, /data-in-freq="monthly" aria-checked="true"/);
  assert.match(box.innerHTML, /A period starts on/);
  assert.doesNotMatch(box.innerHTML, /data-in-rec/);
  vm.runInContext(`inSheet.f.creditFrequency = 'daily'; inSheet.f.ratePercent = '5.5'; inRender();`, c);
  assert.match(box.innerHTML, /data-in-rec="month" aria-checked="true"><b>One entry for the month/);
  assert.match(box.innerHTML, /data-in-rec="day" aria-checked="false"><b>A new entry every day/);
  assert.equal((box.innerHTML.match(/Interest · \d+ Nov/g) || []).length, 3, 'three example day rows');
  assert.match(box.innerHTML, /one entry for the month that grows every night/);
  vm.runInContext(`inSheet.f.recordMode = 'day'; inRender();`, c);
  assert.match(box.innerHTML, /shown as a new entry every day/);
  assert.match(read('interest.js'), /recordMode: f\.creditFrequency === 'daily' \? f\.recordMode : undefined/, 'sent only for daily');
});
