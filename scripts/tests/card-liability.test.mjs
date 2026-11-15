// Credit cards (2026-11-11): a card spend adds to the owed amount shown (last recorded balance + card movements since,
// marked estimated, nothing written), and a card purchase counts as a card spend for spend-based rewards (Monies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { accountHierarchyRows, applyCardMoves } from '../../api/_queries.js';
import { valuePortfolio } from '../../api/_valuation.js';

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const acc = (key, name, type) => a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency)
    VALUES($1,$2,'Slice',$3,$4,$4,'INR') RETURNING id`, [u.id, key, name, type]).then(r => r[0].id);
  const card = await acc('slice-cc', 'Slice Credit Card', 'credit_card'), savings = await acc('slice-sav', 'Slice Savings', 'savings');
  await a.query(`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-11T12:40:00Z',30557.95,'reported'),($2,'2026-11-11T12:40:00Z',42871,'verified')`, [card, savings]);
  const tx = (kind, category, amount, day, accountId, createdAt = '2026-11-12T00:00:00Z') => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on,created_at)
    VALUES($1,$2,$3,$3,$4,'',$5,$6,$7)`, [u.id, kind, category, amount, accountId, day, createdAt]);
  return { a, uid: u.id, card, savings, tx };
}

test('card spends after the recorded balance add to what is owed; refunds and bill payments reduce it; estimated', async () => {
  const { a, uid, card, savings, tx } = await setup();
  await tx('investment', 'Investment', 21, '2026-11-11', card, '2026-11-11T11:40:00Z');  // already inside the 12:40 balance
  await tx('expense', 'Old statement row', 999, '2026-11-02', card);                     // older day, entered later: ignored
  await tx('expense', 'Zepto', 450, '2026-11-12', card);
  await tx('investment', 'MMTC PAMP', 100, '2026-11-12', card);
  await tx('income', 'Credit card refund', 50, '2026-11-13', card);
  await tx('transfer', 'Card payment', 1000, '2026-11-14', card);
  await tx('liability', 'Credit card outstanding', 30557.95, '2026-11-12', card);       // statement summary: ignored
  await tx('expense', 'Swiggy', 300, '2026-11-12', savings);                             // savings: unchanged
  const rows = await accountHierarchyRows(uid, a);
  const c = rows.balances.find(b => b.account_id === card), s = rows.balances.find(b => b.account_id === savings);
  assert.deepEqual([c.balance, c.status, c.recordedBalance], [30057.95, 'estimated', 30557.95]);      // + 450 + 100 − 50 − 1000
  assert.match(c.note, /₹30,557\.95 recorded 2026-11-11 − ₹500 card activity since \(2 spends\)/);
  assert.deepEqual([s.balance, s.status], [42871, 'verified']);
  const [n] = await a.query(`SELECT count(*)::int n FROM wealth_account_balances`);
  assert.equal(n.n, 2, 'nothing written');
  const v = valuePortfolio({ ...rows, now: Date.parse('2026-11-14T12:00:00Z') });
  assert.equal(v.totals.liabilities, 30057.95);
});

test('a spend alone raises the owed amount; no movements leaves the recorded balance as it was', () => {
  const b = [{ account_id: 'c', balance: 30536.95, as_of: '2026-11-10T20:32:03Z', status: 'reported', note: 'x' }];
  assert.equal(applyCardMoves(b, [{ account_id: 'c', delta: 21, spends: 1 }])[0].balance, 30557.95);
  assert.equal(applyCardMoves(b, [])[0], b[0]);
});

// 2026-11-15: a transaction added the way ChatGPT adds it (plain INSERT, saved as pending) and then accepted. Accepting one card spend
// must never hide the other spends from the amount owed (it dropped ₹11,480 → ₹7,680 before the fix).
test('card: spends added like ChatGPT (pending) raise the owed amount; accepting or dismissing one never hides the others', async () => {
  const { acceptTransaction, dismissTransaction, pendingTransactions } = await import('../../api/_accept.js');
  const { a, uid, card, tx } = await setup();
  await tx('expense', 'Amazon', 2300, '2026-11-13', card, '2026-11-13T05:00:00Z');
  await tx('expense', 'Flipkart', 1500, '2026-11-14', card, '2026-11-14T05:00:00Z');
  await tx('expense', 'Swiggy', 1200, '2026-11-15', card, '2026-11-15T05:00:00Z');
  const owed = async () => (await accountHierarchyRows(uid, a)).balances.find(b => b.account_id === card).balance;
  const id = async c => (await a.query(`SELECT id FROM wealth_transactions WHERE category=$1`, [c]))[0].id;
  const [st] = await a.query(`SELECT count(*) FILTER (WHERE review_status = 'pending')::int AS n FROM wealth_transactions`);
  assert.equal(st.n, 3, 'a plain insert waits as pending');
  assert.equal(await owed(), 35557.95, '30,557.95 + 2,300 + 1,500 + 1,200: counted at once, before Accept');
  const pend = await pendingTransactions(uid, { db: a });
  const sw = pend.find(p => p.description === 'Swiggy');
  assert.deepEqual([sw.balance, sw.after], [34357.95, 35557.95], 'the preview starts from the amount owed shown, without this payment');
  const now = Date.parse('2026-11-15T10:00:00Z');
  await acceptTransaction(uid, { transactionId: await id('Swiggy') }, { db: a, now });
  assert.equal(await owed(), 35557.95, 'accepting one spend changes nothing shown (it was already counted) and hides no other spend');
  await acceptTransaction(uid, { transactionId: await id('Amazon') }, { db: a, now: now + 60e3 });
  assert.equal(await owed(), 35557.95);
  await dismissTransaction(uid, { transactionId: await id('Flipkart') }, { db: a, now: now + 120e3 });
  assert.equal(await owed(), 34057.95, 'a dismissed spend leaves the amount owed');
  // A new statement / screenshot balance starts the count again: older spends are inside it.
  await a.query(`INSERT INTO wealth_account_balances(account_id,as_of,balance,status,entered_by) VALUES($1,'2026-11-16T06:00:00Z',36000,'reported','agent')`, [card]);
  assert.equal(await owed(), 36000);
});
