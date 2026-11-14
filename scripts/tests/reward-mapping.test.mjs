// Rewards mapped to payments (2026-11-14): one reward available = mapped and calculated by itself; two or more = nothing is mapped by
// itself, the payment is flagged (yellow) and the owner maps one, two or many by hand, now or later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { pendingTransactions, acceptTransaction, applyOffersToTransaction } from '../../api/_accept.js';
import { saveOffer, rewardState, choicesForTransactions } from '../../api/_offers.js';
import { pageTransactions } from '../../api/_queries.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const card = (await createAccount(u.id, { subtype: 'credit_card', institution: 'HDFC Bank', name: 'Swiggy Card' }, { db: a })).account.id;
  await recordBalance(u.id, { accountId: card, balance: 2000, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
  const tx = async (description, amount) => (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food',$2,$3,'',$4,'2026-11-13') RETURNING id`, [u.id, description, amount, card]))[0].id;
  const offer = (title, v, extra = {}) => saveOffer(u.id, { accountId: card, title, benefitType: 'percent', benefitValue: v, ...extra }, { db: a }).then(r => r.id);
  return { a, uid: u.id, card, tx, offer };
}
const m = (id, over = {}) => ({ id, shadowed: null, apply: 'auto', ...over });

test('the rule: none, auto (exactly one automatic), ask (one that needs activation), choose (two or more)', () => {
  assert.equal(rewardState([]), 'none');
  assert.equal(rewardState([m('a')]), 'auto');
  assert.equal(rewardState([m('a', { apply: 'ask' })]), 'ask');
  assert.equal(rewardState([m('a'), m('b')]), 'choose');
  assert.equal(rewardState([m('a'), m('b', { apply: 'ask' })]), 'choose');
  assert.equal(rewardState([m('a'), m('b', { shadowed: 'a' })]), 'auto', 'an offer hidden by its exclusive group is not counted');
});

test('one reward available: it is mapped and calculated by itself on Accept', async () => {
  const { a, uid, tx, offer } = await setup();
  await offer('5% cashback', 5);
  const id = await tx('Zepto', 800);
  assert.equal((await pendingTransactions(uid, { db: a })).find(x => x.id === id).rewardState, 'auto');
  const r = await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  assert.deepEqual(r.applied.map(x => [x.title, x.inr]), [['5% cashback', 40]]);
  assert.equal(r.needsChoice, false);
});

test('two rewards available: flagged yellow, nothing mapped by itself, the payment is still accepted', async () => {
  const { a, uid, card, tx, offer } = await setup();
  await offer('5% cashback', 5); await offer('Flat 20 off', 0, { benefitType: 'flat', benefitValue: 20 });
  const id = await tx('Zepto', 800);
  const pend = (await pendingTransactions(uid, { db: a })).find(x => x.id === id);
  assert.equal(pend.rewardState, 'choose');
  assert.equal(pend.offers.length, 2);
  const r = await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  assert.equal(r.accepted, true);
  assert.deepEqual(r.applied, []);
  assert.equal(r.needsChoice, true);
  assert.equal(r.after, 2800, 'the balance moved (amount owed on the card went up) even though no reward was mapped');
  // The Transactions page row carries the yellow flag and the choices.
  const row = (await pageTransactions(uid, {}, a)).transactions.find(x => x.id === id);
  assert.equal(row.needsMapping, true);
  assert.deepEqual(row.rewardChoices.map(c => c.title).sort(), ['5% cashback', 'Flat 20 off']);
  assert.deepEqual(row.rewards, []);
});

test('manual mapping: one, two or many rewards, exactly the ones ticked; the yellow flag goes away', async () => {
  const { a, uid, tx, offer } = await setup();
  const o1 = await offer('5% cashback', 5), o2 = await offer('Flat 20 off', 0, { benefitType: 'flat', benefitValue: 20 }), o3 = await offer('Bonus 2%', 2);
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  const one = await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1] }, { db: a });
  assert.deepEqual(one.applied.map(x => x.title), ['5% cashback']);
  let row = (await pageTransactions(uid, {}, a)).transactions.find(x => x.id === id);
  assert.equal(row.needsMapping, false, 'something is mapped now: no longer yellow');
  assert.deepEqual(row.rewardChoices.map(c => c.title).sort(), ['Bonus 2%', 'Flat 20 off'], 'the rest can still be added');
  const two = await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o2, o3] }, { db: a });
  assert.deepEqual(two.applied.map(x => x.title).sort(), ['Bonus 2%', 'Flat 20 off']);
  row = (await pageTransactions(uid, {}, a)).transactions.find(x => x.id === id);
  assert.equal(row.rewards.length, 3);
  assert.deepEqual(row.rewardChoices, []);
});

test('the owner may map two offers of one exclusive group by hand; the default never maps anything when several match', async () => {
  const { a, uid, tx, offer } = await setup();
  const g1 = await offer('Tier 1%', 1, { exclusiveGroup: 'tiers' }), g2 = await offer('Tier 3%', 3, { exclusiveGroup: 'tiers' });
  const id = await tx('Zepto', 1000);
  const none = await acceptTransaction(uid, { transactionId: id, applyOfferIds: [] }, { db: a, now: NOW });
  assert.deepEqual(none.applied, [], 'an empty tick list maps nothing');
  const both = await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [g1, g2] }, { db: a });
  assert.equal(both.applied.length, 2, 'explicit choice is respected, group or not');
});

test('a payment with no match, a repayment and a pending one carry no flag', async () => {
  const { a, uid, tx, offer } = await setup();
  await offer('Zomato only', 10, { merchants: 'zomato' });
  await offer('Swiggy only', 10, { merchants: 'swiggy' });
  const id = await tx('Zepto', 500);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  const row = (await pageTransactions(uid, {}, a)).transactions.find(x => x.id === id);
  assert.deepEqual([row.needsMapping, row.rewardChoices], [false, []]);
  const pending = await tx('Swiggy dinner', 500);
  const map = await choicesForTransactions(uid, [pending], { db: a });
  assert.equal(map.size, 0, 'only accepted payments are offered for mapping');
});

test('screens: yellow block when several match, nothing pre-ticked, tag and tick-box panel on the Transactions row', () => {
  const ui = read('offers.js');
  for (const s of ["t.rewardState === 'choose'", "(choose ? ' choose' : '')", 'rewards match — you choose', 'rewards to map', 'data-tx-map-id', 'data-tx-map="', 'Map another reward', "action: 'apply_offers'", 'applyOfferIds: ids']) assert.ok(ui.includes(s), s);
  assert.match(ui, /const on = !choose && m\.apply === 'auto' && !m\.shadowed/);
  const css = read('style.css');
  for (const s of ['.pd-rewards.choose', '.act-tag.reward.need', '.of-map.need']) assert.ok(css.includes(s), s);
  assert.match(css, /\.pd-rewards\.choose\{[^}]*#2a2412/);
});

// ---- cashback goes into the history, points go to the program ----
import { setEarningStatus, deleteTransaction } from '../../api/_offers.js';
import { upsertRewardProgram } from '../../api/_rewards.js';
const owed = (a, card) => a.query(`SELECT balance::float8 AS b FROM wealth_v_latest_balances WHERE account_id=$1`, [card]).then(r => r[0].b);

test('mapping cashback by hand writes a "Cashback" income to the history for the account and moves the balance, once per reward', async () => {
  const { a, uid, card, tx, offer } = await setup();
  const o1 = await offer('5% cashback', 5), o2 = await offer('Flat 20 off', 0, { benefitType: 'flat', benefitValue: 20 });
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  assert.equal(await owed(a, card), 2800);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE category='Cashback'`))[0].n, 0, 'nothing is written while it is unmapped');
  const r = await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1, o2] }, { db: a, now: NOW + 5000 });
  assert.equal(r.cashbackPosted.length, 2);
  const cb = await a.query(`SELECT kind, amount::float8 AS amt, account_id, review_status, description FROM wealth_transactions WHERE category='Cashback' ORDER BY amount`);
  assert.deepEqual(cb.map(x => [x.kind, x.amt, x.account_id === card, x.review_status]), [['income', 20, true, 'accepted'], ['income', 40, true, 'accepted']]);
  assert.match(cb[0].description, /Cashback · .*Zepto/);
  assert.equal(await owed(a, card), 2740, 'owed 2800 - 40 - 20');
  assert.deepEqual((await a.query(`SELECT status FROM wealth_offer_uses ORDER BY benefit`)).map(x => x.status), ['received', 'received']);
  await applyOffersToTransaction(uid, { transactionId: id, applyOfferIds: [o1] }, { db: a, now: NOW + 9000 });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE category='Cashback'`))[0].n, 2, 'mapping the same reward again adds nothing');
  assert.equal(await owed(a, card), 2740);
});

test('on a savings account the cashback adds to the balance; points make no history entry and go to the points program', async () => {
  const { a, uid, tx, offer } = await setup();
  const sav = (await createAccount(uid, { subtype: 'savings', institution: 'Slice', name: 'Slice Savings' }, { db: a })).account.id;
  await recordBalance(uid, { accountId: sav, balance: 10000, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
  const prog = (await upsertRewardProgram(uid, { programKey: 'pts', provider: 'X', name: 'X points', unit: 'points', accountId: sav }, { db: a })).programId;
  await saveOffer(uid, { accountId: sav, title: 'Cash 5%', benefitType: 'percent', benefitValue: 5 }, { db: a });
  const pay = (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food','Shop',1000,'',$2,'2026-11-13') RETURNING id`, [uid, sav]))[0].id;
  await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.equal(await owed(a, sav), 9050, '10000 - 1000 payment + 50 cashback');
  assert.equal((await a.query(`SELECT current_balance::float8 AS b FROM wealth_accounts WHERE id=$1`, [sav]))[0].b, 9050, 'the legacy balance column follows');
  // points: a second account whose only offer earns points
  const sav2 = (await createAccount(uid, { subtype: 'savings', institution: 'Atom', name: 'Atom Savings' }, { db: a })).account.id;
  await recordBalance(uid, { accountId: sav2, balance: 500, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
  await saveOffer(uid, { accountId: sav2, title: 'Points per 100', benefitType: 'per_block', benefitValue: 4, blockAmount: 100, rewardUnit: 'points', programId: prog }, { db: a });
  const p2 = (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food','Shop 2',300,'',$2,'2026-11-13') RETURNING id`, [uid, sav2]))[0].id;
  const r = await acceptTransaction(uid, { transactionId: p2 }, { db: a, now: NOW + 1000 });
  assert.deepEqual(r.applied.map(x => [x.kind, x.units]), [['points', 12]]);
  assert.deepEqual(r.cashbackPosted, [], 'points are not money: no history entry');
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE category='Cashback'`))[0].n, 1);
  assert.equal((await a.query(`SELECT units::float8 AS u, status FROM wealth_offer_uses WHERE kind='points'`))[0].u, 12);
});

test('a cashback already in the history cannot be reopened or removed from the reward; deleting the payment takes its cashback entry with it', async () => {
  const { a, uid, tx, offer } = await setup();
  await offer('5% cashback', 5);
  const id = await tx('Zepto', 800);
  await acceptTransaction(uid, { transactionId: id }, { db: a, now: NOW });
  const [earning] = await a.query(`SELECT id FROM wealth_offer_uses`);
  await assert.rejects(setEarningStatus(uid, { earningId: earning.id, status: 'cancelled' }, { db: a }), e => e.status === 409 && /already in your history/.test(e.message));
  await assert.rejects(setEarningStatus(uid, { earningId: earning.id, status: 'expected' }, { db: a }), e => e.status === 409);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE category='Cashback'`))[0].n, 1);
  await deleteTransaction(uid, id, { db: a });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE category='Cashback'`))[0].n, 0, 'the cashback entry goes with its payment');
  assert.equal((await a.query(`SELECT status FROM wealth_offer_uses`))[0].status, 'cancelled');
});

test('screens say where the cashback went', () => {
  const ui = read('offers.js');
  assert.ok(ui.includes('added to history as Cashback') && ui.includes('added to points'));
});
