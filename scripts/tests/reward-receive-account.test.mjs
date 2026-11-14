// The account that receives a cashback (migration 0033, 2026-11-14): an offer can name it, it can be chosen when mapping, and it can be
// changed later on the payment (the history entry and both balances move). Default: the account the payment was made from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { acceptTransaction, applyOffersToTransaction, changeReceiveAccount } from '../../api/_accept.js';
import { saveOffer } from '../../api/_offers.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const owed = (a, id) => a.query(`SELECT balance::float8 AS b FROM wealth_v_latest_balances WHERE account_id=$1`, [id]).then(r => r[0].b);

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const mk = async (subtype, institution, name, balance) => {
    const id = (await createAccount(u.id, { subtype, institution, name }, { db: a })).account.id;
    if (balance != null) await recordBalance(u.id, { accountId: id, balance, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
    return id;
  };
  const card = await mk('credit_card', 'HDFC Bank', 'Swiggy Card', 2000), sav = await mk('savings', 'Slice', 'Slice Savings', 10000);
  const tx = async (description, amount) => (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food',$2,$3,'',$4,'2026-11-13') RETURNING id`, [u.id, description, amount, card]))[0].id;
  const offer = (title, v, extra = {}) => saveOffer(u.id, { accountId: card, title, benefitType: 'percent', benefitValue: v, ...extra }, { db: a }).then(r => r.id);
  return { a, uid: u.id, card, sav, mk, tx, offer };
}

test('an offer can name the account that receives its cashback: the history entry and the balance go there, not to the paying card', async () => {
  const { a, uid, card, sav, tx, offer } = await setup();
  await offer('5% cashback', 5, { receiveAccountId: sav });
  const id = await tx('Zepto', 800);
  const r = await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  assert.equal(r.cashbackPosted[0].accountId, sav);
  const [cb] = await a.query(`SELECT account_id, amount::float8 AS amt, description FROM wealth_transactions WHERE category='Cashback'`);
  assert.deepEqual([cb.account_id === sav, cb.amt], [true, 40]);
  assert.match(cb.description, /paid on HDFC Bank/);
  assert.equal(await owed(a, card), 2800, 'the card only carries the payment');
  assert.equal(await owed(a, sav), 10040, 'the cashback landed in savings');
  assert.equal((await a.query(`SELECT receive_account_id FROM wealth_offer_uses`))[0].receive_account_id, sav);
});

test('the receiving account can be chosen when mapping, and must be the user\'s own cash or card account', async () => {
  const { a, uid, card, sav, mk, tx, offer } = await setup();
  const o1 = await offer('5% cashback', 5), o2 = await offer('Flat 20 off', 0, { benefitType: 'flat', benefitValue: 20 });
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  const [other] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('x@example.test','x','user') RETURNING id`);
  const foreign = (await createAccount(other.id, { subtype: 'savings', institution: 'Other', name: 'Theirs' }, { db: a })).account.id;
  await assert.rejects(applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1], receive: { [o1]: foreign } }, { db: a }), e => e.status === 400, 'someone else\'s account');
  const demat = await mk('demat_equity', 'Broker', 'Demat');
  await assert.rejects(applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1], receive: { [o1]: demat } }, { db: a }), e => e.status === 400, 'not a cash or card account');
  const r = await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1, o2], receive: { [o1]: sav } }, { db: a, now: NOW + 5000 });
  assert.equal(r.cashbackPosted.length, 2);
  const by = Object.fromEntries((await a.query(`SELECT amount::float8 AS amt, account_id FROM wealth_transactions WHERE category='Cashback'`)).map(x => [x.amt, x.account_id]));
  assert.equal(by[40], sav, 'the 5% cashback went to savings, as chosen');
  assert.equal(by[20], card, 'the other stayed on the paying card');
  assert.equal(await owed(a, sav), 10040);
  assert.equal(await owed(a, card), 2780, 'owed 2000 + 800 payment - 20');
});

test('changing the receiving account later moves the history entry and both balances; no-ops and bad requests are refused', async () => {
  const { a, uid, card, sav, mk, tx, offer } = await setup();
  await offer('5% cashback', 5);
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  assert.equal(await owed(a, card), 2760);
  const [earning] = await a.query(`SELECT id FROM wealth_offer_uses`);
  assert.equal((await changeReceiveAccount(uid, { earningId: earning.id, accountId: card }, { db: a, now: NOW + 3000 })).changed, false);
  const r = await changeReceiveAccount(uid, { earningId: earning.id, accountId: sav }, { db: a, now: NOW + 6000 });
  assert.deepEqual([r.changed, r.moved], [true, true]);
  assert.equal(await owed(a, card), 2800, 'the card owes the 40 again');
  assert.equal(await owed(a, sav), 10040, 'savings received it');
  assert.deepEqual((await a.query(`SELECT account_id FROM wealth_transactions WHERE category='Cashback'`)).map(x => x.account_id === sav), [true], 'one history entry, now on savings');
  assert.equal((await a.query(`SELECT receive_account_id FROM wealth_offer_uses`))[0].receive_account_id, sav);
  assert.equal((await a.query(`SELECT current_balance::float8 AS b FROM wealth_accounts WHERE id=$1`, [sav]))[0].b, 10040, 'the legacy savings balance follows');
  const back = await changeReceiveAccount(uid, { earningId: earning.id, accountId: card }, { db: a, now: NOW + 9000 });
  assert.equal(back.moved, true);
  assert.equal(await owed(a, card), 2760);
  assert.equal(await owed(a, sav), 10000);
  const demat = await mk('demat_equity', 'Broker', 'Demat');
  await assert.rejects(changeReceiveAccount(uid, { earningId: earning.id, accountId: demat }, { db: a }), e => e.status === 400);
  await assert.rejects(changeReceiveAccount(uid, { earningId: 'nope', accountId: sav }, { db: a }), e => e.status === 400);
  const [stranger] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('z@example.test','x','user') RETURNING id`);
  await assert.rejects(changeReceiveAccount(stranger.id, { earningId: earning.id, accountId: sav }, { db: a }), e => e.status === 404);
});

test('an older expected cashback (not in the history) only remembers the new account; points cannot be given an account', async () => {
  const { a, uid, sav, tx, offer } = await setup();
  await offer('5% cashback', 5);
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  await a.query(`UPDATE wealth_offer_uses SET status='expected', credited_transaction_id=NULL, credited_on=NULL`);
  await a.query(`DELETE FROM wealth_transactions WHERE external_ref LIKE 'reward:%'`);
  const [earning] = await a.query(`SELECT id FROM wealth_offer_uses`);
  const before = await owed(a, sav);
  const r = await changeReceiveAccount(uid, { earningId: earning.id, accountId: sav }, { db: a });
  assert.deepEqual([r.changed, r.moved], [true, false]);
  assert.equal(await owed(a, sav), before, 'no balance moved: nothing was in the history');
  await a.query(`UPDATE wealth_offer_uses SET kind='points'`);
  await assert.rejects(changeReceiveAccount(uid, { earningId: earning.id, accountId: sav }, { db: a }), e => e.status === 400 && /points/i.test(e.message));
});

test('screens, route and migration are wired', () => {
  const ui = read('offers.js');
  for (const s of ['Cashback is received in', 'receiveAccountId', 'data-of-recv', 'data-tx-map-recv', 'data-earn-recv', "action: 'receive_account'", 'function ofRecvOptions', 'receive: accept ? receive : undefined', 'applyOfferIds: ids, receive']) assert.ok(ui.includes(s), s);
  assert.match(read('api/_routes/offer-earnings.js'), /receive_account/);
  const mig = read('scripts/migrations/0033_reward_receive_account.sql');
  assert.match(mig, /ADD COLUMN IF NOT EXISTS receive_account_id/);
  assert.doesNotMatch(mig, /\bDROP\b|DELETE FROM|TRUNCATE/i);
});
