import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migratedDb } from './helpers/pglite.mjs';
import { pageTransactions, spendingRows, decodeCursor } from '../../api/_queries.js';

const TOTAL = 620; // more than the old LIMIT 500 that silently dropped history (DEF-05)

async function seeded() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('owner@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,masked_identifier)
    VALUES($1,'bank-1','Bank','Savings','savings','••0001') RETURNING id`, [u.id]);
  // One INSERT: every row shares the same created_at, so ordering must fall back to id without losing rows.
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    SELECT $1, CASE WHEN g % 10 = 0 THEN 'income' ELSE 'expense' END,
           CASE WHEN g % 3 = 0 THEN 'Food' WHEN g % 3 = 1 THEN 'Travel' ELSE '' END,
           'tx ' || g, (g % 50) + 1, '', $2, DATE '2026-01-01' + (g % 300)
    FROM generate_series(1, $3) g`, [u.id, acc.id, TOTAL]);
  return { a, uid: u.id };
}

test('keyset paging returns every transaction exactly once, newest first (TR-3.2)', async () => {
  const { a, uid } = await seeded();
  const seen = []; let cursor = null, pages = 0;
  do {
    const page = await pageTransactions(uid, { cursor, limit: 200 }, a);
    seen.push(...page.transactions);
    cursor = page.nextCursor; pages++;
  } while (cursor && pages < 10);
  assert.equal(seen.length, TOTAL);
  assert.equal(new Set(seen.map(t => t.id)).size, TOTAL, 'no duplicates across pages');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].occurred_on >= seen[i].occurred_on, 'sorted newest first');
  assert.match(seen[0].occurred_on, /^\d{4}-\d{2}-\d{2}$/, 'dates come back as plain YYYY-MM-DD strings');
});

test('the default first page is 50 rows with a cursor to continue', async () => {
  const { a, uid } = await seeded();
  const page = await pageTransactions(uid, {}, a);
  assert.equal(page.transactions.length, 50);
  assert.ok(decodeCursor(page.nextCursor));
});

test('malformed cursors are ignored instead of reaching SQL', () => {
  assert.equal(decodeCursor('not-base64-json'), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify(["2026-01-01", "x'; drop", "id"])).toString('base64url')), null);
});

test('spending summary covers all transactions, not just a recent page (TR-3.1)', async () => {
  const { a, uid } = await seeded();
  const rows = await spendingRows(uid, a);
  assert.equal(rows.reduce((n, r) => n + r.n, 0), TOTAL);
  assert.ok(rows.some(r => r.category === 'Uncategorised'), 'blank categories are grouped as Uncategorised');
  const expected = (await a.query(`SELECT sum(amount)::float8 s FROM wealth_transactions WHERE kind='expense'`))[0].s;
  const got = rows.filter(r => r.kind === 'expense').reduce((n, r) => n + r.total, 0);
  assert.equal(got, expected);
});

// Browser analytics functions are pure over spendRows; run them exactly as written in app.js.
function loadAnalytics(spendRows) {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const start = src.indexOf('// Spending analytics read spendRows');
  const end = src.indexOf('function parseMoney');
  assert.ok(start > 0 && end > start, 'analytics block found in app.js');
  const ctx = { spendRows, items: [] };
  vm.runInNewContext(src.slice(start, end) + ';globalThis.f={monthlySpendStats,yearlyAverageSpendSeries,monthlyCashSeries,categoryTotals,transactionTotalCount};', ctx);
  return ctx.f;
}

test('monthly average spans every calendar month between first and last expense', () => {
  const f = loadAnalytics([
    { month: '2026-01', kind: 'expense', category: 'Food', total: 300, n: 3 },
    { month: '2026-03', kind: 'expense', category: 'Rent', total: 900, n: 1 },
    { month: '2026-03', kind: 'income', category: 'Salary', total: 5000, n: 1 },
  ]);
  const s = f.monthlySpendStats();
  assert.equal(s.months, 3);
  assert.equal(s.total, 1200);
  assert.equal(s.average, 400);
  assert.equal(f.transactionTotalCount(), 5);
  assert.deepEqual({ ...f.categoryTotals(null) }, { Food: 300, Rent: 900 });
  assert.deepEqual({ ...f.categoryTotals('2026-03') }, { Rent: 900 });
  const cash = f.monthlyCashSeries();
  assert.deepEqual(JSON.parse(JSON.stringify(cash.map(c => [c.month, c.income, c.spend]))), [['2026-01', 0, 300], ['2026-03', 5000, 900]]);
  const yearly = f.yearlyAverageSpendSeries();
  assert.equal(yearly[0].average, 600, 'yearly average divides by months that had expenses (2)');
});

test('no expenses gives zero averages, not NaN', () => {
  const f = loadAnalytics([]);
  assert.deepEqual({ ...f.monthlySpendStats() }, { average: 0, months: 0, total: 0 });
});
