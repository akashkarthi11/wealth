// Reward lifecycle (2026-11-14): removing a mapped reward makes its "Cashback" history entry inactive and puts the balance back; a bank that
// credits cashback only after settlement keeps the reward expected until it is marked received, and then the entry is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { acceptTransaction, applyOffersToTransaction, removeEarning, markCashbackReceived } from '../../api/_accept.js';
import { saveOffer, setEarningStatus } from '../../api/_offers.js';
import { pageTransactions, spendingRows } from '../../api/_queries.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const bal = (a, id) => a.query(`SELECT balance::float8 AS b FROM wealth_v_latest_balances WHERE account_id=$1`, [id]).then(r => r[0].b);

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const mk = async (subtype, institution, name, balance) => {
    const id = (await createAccount(u.id, { subtype, institution, name }, { db: a })).account.id;
    await recordBalance(u.id, { accountId: id, balance, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
    return id;
  };
  const card = await mk('credit_card', 'HDFC Bank', 'Swiggy Card', 2000), sav = await mk('savings', 'Slice', 'Slice Savings', 10000);
  const tx = async (description, amount) => (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food',$2,$3,'',$4,'2026-11-13') RETURNING id`, [u.id, description, amount, card]))[0].id;
  const offer = (title, v, extra = {}) => saveOffer(u.id, { accountId: card, title, benefitType: 'percent', benefitValue: v, ...extra }, { db: a }).then(r => r.id);
  return { a, uid: u.id, card, sav, tx, offer };
}
const cashbackRows = a => a.query(`SELECT id, amount::float8 AS amt, account_id, review_status, duplicate_of, occurred_on::text AS d FROM wealth_transactions WHERE category='Cashback' ORDER BY created_at`);

test('removing a mapped reward makes its Cashback history entry inactive and puts the balance back; the reward stops counting', async () => {
  const { a, uid, card, sav, tx, offer } = await setup();
  await offer('5% cashback', 5, { receiveAccountId: sav });
  const pay = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.equal(await bal(a, sav), 10040);
  const [earning] = await a.query(`SELECT id FROM wealth_offer_uses`);
  const before = (await spendingRows(uid, a)).filter(r => r.category === 'Cashback').reduce((n, r) => n + r.total, 0);
  assert.equal(before, 40);
  const r = await removeEarning(uid, { earningId: earning.id }, { db: a, now: NOW + 5000 });
  assert.deepEqual([r.status, r.inactive], ['cancelled', true]);
  const [cb] = await cashbackRows(a);
  assert.deepEqual([cb.review_status, cb.duplicate_of === pay], ['dismissed', true], 'the entry is kept but inactive');
  assert.equal(await bal(a, sav), 10000, 'savings is back to where it was');
  assert.equal(await bal(a, card), 2800, 'the card still carries the payment');
  assert.equal((await spendingRows(uid, a)).filter(x => x.category === 'Cashback').length, 0, 'totals no longer count it');
  const page = (await pageTransactions(uid, {}, a)).transactions;
  const row = page.find(x => x.category === 'Cashback');
  assert.equal(row.inactive, true, 'it stays in the history list, marked inactive');
  assert.equal(page.find(x => x.id === pay).inactive, false, 'the payment itself is active');
  assert.equal((await a.query(`SELECT status FROM wealth_offer_uses`))[0].status, 'cancelled');
  assert.equal((await a.query(`SELECT current_balance::float8 AS b FROM wealth_accounts WHERE id=$1`, [sav]))[0].b, 10000, 'the legacy balance follows');
  const again = await removeEarning(uid, { earningId: earning.id }, { db: a, now: NOW + 9000 });
  assert.equal(again.status, 'cancelled');
  assert.equal(await bal(a, sav), 10000, 'removing twice puts nothing back twice');
});

test('removing frees the offer\'s one-time use, and the reward can be mapped again to give a fresh entry', async () => {
  const { a, uid, tx, offer } = await setup();
  const o = await offer('Welcome 100', 0, { benefitType: 'flat', benefitValue: 100, frequency: 'one_time' });
  const p1 = await tx('A', 500), p2 = await tx('B', 500);
  await acceptTransaction(uid, { transactionId: p1 }, { db: a, now: NOW });
  const [e1] = await a.query(`SELECT id FROM wealth_offer_uses`);
  await removeEarning(uid, { earningId: e1.id }, { db: a, now: NOW + 1000 });
  await acceptTransaction(uid, { transactionId: p2 }, { db: a, now: NOW + 2000 });
  const live = (await cashbackRows(a)).filter(x => !x.duplicate_of);
  assert.equal(live.length, 1, 'only the new one is active');
  assert.ok(o);
});

test('removing a reward that has no history entry (points, or cashback not yet credited) just cancels it', async () => {
  const { a, uid, tx, offer } = await setup();
  await offer('Pays later', 5, { creditTiming: 'settle' });
  const pay = await tx('Zepto', 800);
  const r = await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.deepEqual(r.cashbackPosted, [], 'a settlement offer writes nothing yet');
  const [e] = await a.query(`SELECT id FROM wealth_offer_uses`);
  const out = await removeEarning(uid, { earningId: e.id }, { db: a });
  assert.deepEqual([out.status, out.inactive], ['cancelled', false]);
  assert.equal((await cashbackRows(a)).length, 0);
});

test('a bank that credits after settlement: the reward stays expected, nothing moves; Mark received then adds the entry on that day to the receiving account', async () => {
  const { a, uid, card, sav, tx, offer } = await setup();
  await offer('5% after settlement', 5, { creditTiming: 'settle', receiveAccountId: sav });
  const pay = await tx('Zepto', 800);
  const r = await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].creditTiming, 'settle');
  assert.deepEqual(r.cashbackPosted, []);
  const [e] = await a.query(`SELECT id, status, credited_transaction_id FROM wealth_offer_uses`);
  assert.deepEqual([e.status, e.credited_transaction_id], ['expected', null]);
  assert.equal((await cashbackRows(a)).length, 0, 'no history entry yet');
  assert.equal(await bal(a, sav), 10000);
  assert.equal(await bal(a, card), 2800, 'only the payment moved the card');
  const got = await markCashbackReceived(uid, { earningId: e.id, creditedOn: '2026-12-20' }, { db: a, now: NOW + 5000 });
  assert.deepEqual([got.status, got.posted], ['received', true]);
  const [cb] = await cashbackRows(a);
  assert.deepEqual([cb.amt, cb.account_id === sav, cb.d, cb.review_status], [40, true, '2026-12-20', 'accepted'], 'added on the day the bank credited it');
  assert.equal(await bal(a, sav), 10040);
  const [after] = await a.query(`SELECT status, credited_on::text AS d FROM wealth_offer_uses`);
  assert.deepEqual([after.status, after.d], ['received', '2026-12-20']);
  const twice = await markCashbackReceived(uid, { earningId: e.id }, { db: a, now: NOW + 9000 });
  assert.equal((await cashbackRows(a)).length, 1, 'marking it again adds nothing');
  assert.ok(twice);
});

test('marking received with a real credit that is already in the history only links it (no second entry)', async () => {
  const { a, uid, card, tx, offer } = await setup();
  await offer('5% after settlement', 5, { creditTiming: 'settle' });
  const pay = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  const credit = (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on,review_status) VALUES($1,'income','Credit card cashback','Cashback credit',40,'',$2,'2026-12-20',NULL) RETURNING id`, [uid, card]))[0].id;
  const [e] = await a.query(`SELECT id FROM wealth_offer_uses`);
  const r = await markCashbackReceived(uid, { earningId: e.id, creditedTransactionId: credit }, { db: a, now: NOW + 5000 });
  assert.equal(r.status, 'received');
  assert.equal((await cashbackRows(a)).length, 0, 'the real credit is the history entry; the app adds none');
  assert.equal((await a.query(`SELECT credited_transaction_id FROM wealth_offer_uses`))[0].credited_transaction_id, credit);
});

test('an offer saves its credit timing; an unknown timing is refused; a later map keeps the offer\'s timing', async () => {
  const { a, uid, card, tx, offer } = await setup();
  await assert.rejects(saveOffer(uid, { accountId: card, title: 'x', benefitType: 'percent', benefitValue: 5, creditTiming: 'later' }, { db: a }), e => e.status === 400);
  const o = await offer('5% after settlement', 5, { creditTiming: 'settle' });
  assert.equal((await a.query(`SELECT credit_timing FROM wealth_account_offers WHERE id=$1`, [o]))[0].credit_timing, 'settle');
  const pay = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: pay, applyOfferIds: [] }, { db: a, now: NOW });
  const m = await applyOffersToTransaction(uid, { transactionId: pay, applyOfferIds: [o] }, { db: a, now: NOW + 3000 });
  assert.deepEqual(m.cashbackPosted, []);
  assert.equal((await a.query(`SELECT status FROM wealth_offer_uses`))[0].status, 'expected');
});

test('screens, route and migration are wired', () => {
  const ui = read('offers.js');
  for (const s of ['When the bank credits it', 'creditTiming', 'credited after settlement', 'data-earn-posted', 'becomes inactive and the account balance is put back']) assert.ok(ui.includes(s), s);
  const route = read('api/_routes/offer-earnings.js');
  assert.match(route, /removeEarning/); assert.match(route, /markCashbackReceived/);
  const mig = read('scripts/migrations/0036_offer_credit_timing.sql');
  assert.match(mig, /ADD COLUMN IF NOT EXISTS credit_timing/);
  assert.doesNotMatch(mig, /\bDROP\b|DELETE FROM|TRUNCATE/i);
});
