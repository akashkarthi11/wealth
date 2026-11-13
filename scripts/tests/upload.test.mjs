// Transaction upload (2026-11-12): rows from the sample Excel/CSV are saved for the signed-in user only; one bad row
// rejects the whole file; existing rows are skipped; the password is required every time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { importTransactions } from '../../api/_upload.js';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'hdfc','HDFC','HDFC Savings','savings','savings','INR') RETURNING id`, [u.id]);
  return { a, uid: u.id, other: o.id, accId: acc.id };
}
const row = (o = {}) => ({ date: '2026-11-10', type: 'expense', category: 'Food', description: 'Lunch', amount: '450', account: '', reference: '', ...o });
const count = (a, uid) => a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE user_id=$1`, [uid]).then(r => r[0].n);

test('valid rows are saved against the signed-in user only, with account matched by name', async () => {
  const { a, uid, other, accId } = await setup();
  const r = await importTransactions(uid, [row(), row({ type: 'INCOME', category: 'Salary', description: 'Pay', amount: '50,000.50', account: 'hdfc savings', reference: 'R-1' })], { db: a, now: NOW });
  assert.deepEqual(r, { received: 2, added: 2, skipped: 0 });
  const t = await a.query(`SELECT kind, amount::float8 amt, account_id, external_ref, user_id FROM wealth_transactions ORDER BY amount`);
  assert.deepEqual(t.map(x => [x.kind, x.amt, x.user_id === uid]), [['expense', 450, true], ['income', 50000.5, true]]);
  assert.equal(t[1].account_id, accId); assert.equal(t[1].external_ref, 'R-1');
  assert.equal(await count(a, other), 0);
});

test('one bad row rejects the whole file with row numbers; nothing is saved', async () => {
  const { a, uid } = await setup();
  const bad = [row(), row({ type: 'gift' }), row({ amount: '-5' }), row({ date: '12/11/2026' }), row({ category: '' }), row({ account: 'Nope' }), row({ date: '2026-12-31' }), row({ date: '2026-02-31' })];
  await assert.rejects(importTransactions(uid, bad, { db: a, now: NOW }), e => e.status === 400 && e.details.map(d => d.row).join() === '3,4,5,6,7,8,9' && /Nothing was uploaded/.test(e.message));
  assert.equal(await count(a, uid), 0);
  await assert.rejects(importTransactions(uid, [], { db: a }), e => e.status === 400);
  await assert.rejects(importTransactions(uid, Array.from({ length: 501 }, () => row()), { db: a }), e => e.status === 400);
});

test('someone else\'s account name is not accepted', async () => {
  const { a, other } = await setup();
  await assert.rejects(importTransactions(other, [row({ account: 'HDFC Savings' })], { db: a, now: NOW }), e => e.status === 400);
});

test('existing rows are skipped: same reference, or same date + amount + type + description; also inside the file', async () => {
  const { a, uid } = await setup();
  await importTransactions(uid, [row({ reference: 'U-1' }), row({ description: 'Tea', amount: '20' })], { db: a, now: NOW });
  const r = await importTransactions(uid, [row({ reference: 'U-1', amount: '999' }), row({ description: 'tea', amount: '20' }), row({ description: 'New', amount: '5' }), row({ description: 'New', amount: '5' })], { db: a, now: NOW });
  assert.deepEqual(r, { received: 4, added: 1, skipped: 3 });
  assert.equal(await count(a, uid), 3);
});

test('wiring: route asks for the password every time, is rate limited, behind the Upload menu; UI has sample + upload', () => {
  const route = read('api/_routes/uploads.js');
  assert.match(route, /check\(String\(b\.password/);
  assert.match(route, /rateLimit\(key, LIMIT, WINDOW\)/);
  assert.match(route, /Password is incorrect/);
  assert.match(read('api/_roles.js'), /'uploads': \['upload'\]/);
  assert.match(read('api/_roles.js'), /key: 'upload'/);
  assert.match(read('api/router.js'), /'uploads': \(\) => import/);
  const app = read('app.js');
  for (const s of ['downloadSample', 'data-upload-go', '/api/uploads', 'DecompressionStream', "view==='upload'"]) assert.ok(app.includes(s), s);
  assert.match(read('index.html'), /data-view="upload"/);
});

// ---- One file, four sheets (accounts, lending, investments) ----
import { importAll } from '../../api/_upload.js';
const acct = (o = {}) => ({ type: 'savings', institution: 'Test Bank', name: 'Test Savings', digits: '1234', currency: 'INR', balance: '25000', asOf: '', ...o });
const lend = (o = {}) => ({ person: 'Asha', direction: 'lent', amount: '5000', date: '2026-11-01', note: 'rent', ...o });
const inv = (o = {}) => ({ type: 'equity', platform: 'Test Broker', name: 'Test Co', symbol: 'TESTCO', quantity: '10', invested: '5000', current: '5600', ...o });

test('all four sheets are saved for the signed-in user; transactions may use an account from the same file', async () => {
  const { a, uid, other } = await setup();
  const r = await importAll(uid, {
    accounts: [acct(), acct({ type: 'credit_card', name: 'Test Card', digits: '9', balance: '8000' }), acct({ type: 'demat_equity', name: 'Test Demat', digits: '77', balance: '' })],
    transactions: [row({ account: 'Test Savings' })],
    lending: [lend(), lend({ direction: 'paid back', amount: '2000', date: '2026-11-05', note: '' })],
    investments: [inv(), inv({ type: 'mutual_fund', name: 'Test Fund', symbol: '', quantity: '120.5', invested: '12000', current: '13250' })],
  }, { db: a, now: NOW });
  assert.deepEqual([r.accounts.added, r.transactions.added, r.lending.added, r.investments.added, r.skipped], [3, 1, 2, 2, 0]);
  const accs = await a.query(`SELECT account_name, subtype_code FROM wealth_accounts WHERE user_id=$1 ORDER BY account_name`, [uid]);
  assert.ok(accs.some(x => x.account_name === 'Test Savings') && accs.some(x => x.subtype_code === 'credit_card'));
  const bal = await a.query(`SELECT b.balance::float8 b, b.status FROM wealth_account_balances b JOIN wealth_accounts x ON x.id=b.account_id WHERE x.user_id=$1 AND x.account_name='Test Card'`, [uid]);
  assert.deepEqual([bal[0].b, bal[0].status], [8000, 'reported']);
  const tx = await a.query(`SELECT a.account_name FROM wealth_transactions t JOIN wealth_accounts a ON a.id=t.account_id WHERE t.user_id=$1`, [uid]);
  assert.equal(tx[0].account_name, 'Test Savings');
  const ent = await a.query(`SELECT direction, amount::float8 amt FROM wealth_person_entries e JOIN wealth_people p ON p.id=e.person_id WHERE p.user_id=$1 ORDER BY amt`, [uid]);
  assert.deepEqual(ent.map(e => [e.direction, e.amt]), [['in', 2000], ['out', 5000]]);
  const pos = await a.query(`SELECT record_type, current_value::float8 v, user_id FROM wealth_positions WHERE source_key LIKE 'upload:%' ORDER BY v`);
  assert.deepEqual(pos.map(p => [p.record_type, p.v, p.user_id === uid]), [['EQUITY', 5600, true], ['MUTUAL_FUND', 13250, true]]);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_investment_assets WHERE user_id=$1`, [uid]))[0].n, 2);
  for (const t of ['wealth_accounts', 'wealth_people', 'wealth_transactions', 'wealth_positions']) assert.equal((await a.query(`SELECT count(*)::int n FROM ${t} WHERE user_id=$1`, [other]))[0].n, 0, t + ' untouched for the other user');
});

test('uploading the same file again adds nothing (every sheet skips what exists)', async () => {
  const { a, uid } = await setup();
  const file = { accounts: [acct()], transactions: [row()], lending: [lend()], investments: [inv()] };
  await importAll(uid, file, { db: a, now: NOW });
  const r = await importAll(uid, file, { db: a, now: NOW });
  assert.deepEqual([r.added, r.skipped], [0, 4]);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_positions WHERE user_id=$1`, [uid]))[0].n, 1);
});

test('one bad row in any sheet rejects everything, with the sheet and row', async () => {
  const { a, uid } = await setup();
  const bad = { accounts: [acct(), acct({ type: 'bank', name: 'X' }), acct({ name: 'Y', digits: '2', balance: '-5' }), acct({ type: 'demat_equity', name: 'Z', digits: '3', balance: '10' })],
    transactions: [row(), row({ account: 'Nobody' })], lending: [lend({ direction: 'gave up' }), lend({ amount: '0' })], investments: [inv({ type: 'bitcoin' }), inv({ quantity: '0', name: 'B' }), inv({ current: '', name: 'C' })] };
  await assert.rejects(importAll(uid, bad, { db: a, now: NOW }), e => e.status === 400 && e.details.map(d => d.sheet + ':' + d.row).join() === 'Accounts:3,Accounts:4,Accounts:5,Transactions:3,Lending:2,Lending:3,Investments:2,Investments:3,Investments:4');
  for (const [t, n] of [['wealth_accounts', 1], ['wealth_transactions', 0], ['wealth_people', 0], ['wealth_positions', 0]]) assert.equal((await a.query(`SELECT count(*)::int n FROM ${t} WHERE user_id=$1`, [uid]))[0].n, n, t);
  await assert.rejects(importAll(uid, {}, { db: a }), e => e.status === 400);
  await assert.rejects(importAll(uid, { lending: Array.from({ length: 51 }, () => lend()) }, { db: a }), e => e.status === 400 && /at most 50/.test(e.message));
});

test('wiring: four sheets in the sample and reader; password route accepts all sets', () => {
  const app = read('app.js');
  for (const s of ['wealth-upload-sample.xlsx', 'UP_SHEETS', 'xl/workbook.xml', '"Lending"', '"Investments"', '"How to fill"']) assert.ok(app.includes(s), s);
  assert.match(read('api/_routes/uploads.js'), /importAll\(uid, \{ transactions: b\.transactions \?\? b\.rows, accounts: b\.accounts, lending: b\.lending, investments: b\.investments \}/);
});
