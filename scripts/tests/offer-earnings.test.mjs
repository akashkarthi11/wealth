// Offers that work by themselves (migration 0031, 2026-11-14): when a payment is accepted the matching offers are applied; cashback is
// recorded as expected on the payment (never as ledger income) and linked to the real credit later; points go to their reward program.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance, markDuplicate } from '../../api/_ingest.js';
import { pendingTransactions, acceptTransaction, applyOffersToTransaction } from '../../api/_accept.js';
import { saveOffer, deleteOffer, listOffers, computeEarning, matchOffers, activeOffersFor, listEarnings, setEarningStatus, earningsForTransactions } from '../../api/_offers.js';
import { upsertRewardProgram, recordRewardBalance, rewardsOverview } from '../../api/_rewards.js';
import { pageTransactions } from '../../api/_queries.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
// Earnings made before cashback was written to the history (status expected, no history row): the receive / link machinery still serves them.
const legacyExpected = async a => { await a.query(`UPDATE wealth_offer_uses SET status='expected', credited_transaction_id=NULL, credited_on=NULL WHERE kind='cashback'`); await a.query(`DELETE FROM wealth_transactions WHERE external_ref LIKE 'reward:%'`); };
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const acc = async (subtype, institution, name, balance) => {
    const id = (await createAccount(u.id, { subtype, institution, name }, { db: a })).account.id;
    if (balance != null) await recordBalance(u.id, { accountId: id, balance, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
    return id;
  };
  const card = await acc('credit_card', 'HDFC Bank', 'Swiggy Card', 2000);
  const sav = await acc('savings', 'Slice', 'Slice Savings', 20000);
  const tx = async (accountId, kind, category, description, amount, day = '2026-11-13') =>
    (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,$2,$3,$4,$5,'',$6,$7) RETURNING id`, [u.id, kind, category, description, amount, accountId, day]))[0].id;
  const credit = async (amount, day, category = 'Credit card cashback', description = 'Cashback credit') =>
    (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on,review_status) VALUES($1,'income',$2,$3,$4,'',$5,$6,NULL) RETURNING id`, [u.id, category, description, amount, card, day]))[0].id;
  const rows = (sqlText, p = []) => a.query(sqlText, p);
  return { a, uid: u.id, other: o.id, card, sav, tx, credit, rows };
}

test('the arithmetic: percent, flat, per block of rupees, caps, points through the program rate', () => {
  const base = { reward_unit: 'cashback', benefit_type: 'percent', benefit_value: 5, max_benefit: null, block_amount: null };
  assert.deepEqual(computeEarning(base, 800), { kind: 'cashback', unit: 'cashback', amount: 40, units: null, inr: 40, percent: 5 });
  assert.equal(computeEarning({ ...base, max_benefit: 30 }, 800).amount, 30, 'capped per payment');
  assert.equal(computeEarning({ ...base, benefit_type: 'flat', benefit_value: 50 }, 100).amount, 50);
  // "4 points per ₹150": ₹400 is two whole blocks
  const blocks = { reward_unit: 'points', benefit_type: 'per_block', benefit_value: 4, block_amount: 150, max_benefit: null };
  assert.equal(computeEarning(blocks, 400).units, 8);
  assert.equal(computeEarning(blocks, 149).units, 0);
  // Slice Monies: 1% of the payment as ₹ value, 1 monie = ₹0.01, so ₹500 -> ₹5 -> 500 monies
  const monies = { reward_unit: 'monies', benefit_type: 'percent', benefit_value: 1, max_benefit: null };
  const e = computeEarning(monies, 500, { inr_per_unit: 0.01 });
  assert.deepEqual([e.units, e.inr, e.percent, e.kind], [500, 5, 1, 'points']);
  assert.equal(computeEarning(monies, 500, null), null, 'a percent of points needs the program rate: never guessed');
  assert.equal(computeEarning(monies, 500, { inr_per_unit: null }), null);
  assert.equal(computeEarning({ ...monies, benefit_type: 'flat', benefit_value: 25 }, 500, null).units, 25, 'flat points need no rate');
});

test('Spark style: minimum and maximum payment, must be activated (ask me), once per user', async () => {
  const { a, uid, sav, tx } = await setup();
  const { id } = await saveOffer(uid, { accountId: sav, title: 'Zepto spark', merchants: 'zepto', benefitType: 'flat', benefitValue: 50, minSpend: 349, maxSpend: 5000, frequency: 'one_time', applyMode: 'ask', paymentMode: 'upi' }, { db: a });
  const { offers, uses, programs } = await activeOffersFor(uid, [sav], { db: a });
  const t = { account_id: sav, kind: 'expense', category: 'Groceries', description: 'UPI payment to Zepto', amount: 500, occurred_on: '2026-11-13' };
  assert.equal(matchOffers(offers, t, uses, programs).length, 1);
  assert.equal(matchOffers(offers, { ...t, amount: 348 }, uses, programs).length, 0, 'below the minimum');
  assert.equal(matchOffers(offers, { ...t, amount: 5001 }, uses, programs).length, 0, 'above the maximum');
  assert.equal(matchOffers(offers, { ...t, amount: 5000 }, uses, programs).length, 1, 'the maximum itself is allowed');
  const p1 = await tx(sav, 'expense', 'Groceries', 'UPI payment to Zepto', 500);
  assert.equal((await pendingTransactions(uid, { db: a })).find(x => x.id === p1).offers[0].apply, 'ask');
  const auto = await acceptTransaction(uid, { transactionId: p1 }, { db: a, now: NOW });
  assert.deepEqual(auto.applied, [], 'an offer that needs activation is not applied unless the owner switches it on');
  assert.equal(auto.offers.length, 1, 'but it is shown');
  const again = await applyOffersToTransaction(uid, { transactionId: p1, applyOfferIds: [id] }, { db: a });
  assert.deepEqual(again.applied.map(x => [x.title, x.inr]), [['Zepto spark', 50]]);
  const p2 = await tx(sav, 'expense', 'Groceries', 'UPI payment to Zepto', 600);
  await acceptTransaction(uid, { transactionId: p2, applyOfferIds: [id] }, { db: a, now: NOW + 5000 });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_offer_uses WHERE status <> 'cancelled'`))[0].n, 1, 'once per user');
});

test('Accept applies the one automatic reward by itself; its cashback goes into the history as income "Cashback" and moves the balance', async () => {
  const { a, uid, card, tx } = await setup();
  await saveOffer(uid, { accountId: card, title: 'Swiggy 5%', merchants: 'swiggy', benefitType: 'percent', benefitValue: 5, maxBenefit: 100, period: 'cycle', cycleDay: 10, periodMaxBenefit: 1500 }, { db: a });
  const pay = await tx(card, 'expense', 'Food', 'Swiggy order', 800);
  const incomeBefore = (await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE kind='income'`))[0].n;
  const r = await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.deepEqual(r.applied.map(x => [x.title, x.inr, x.percent]), [['Swiggy 5%', 40, 5]]);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE kind='income'`))[0].n, incomeBefore + 1, 'the cashback is a history entry now');
  const [cb] = await a.query(`SELECT kind, category, amount::float8 AS amt, account_id, review_status, external_ref FROM wealth_transactions WHERE category='Cashback'`);
  assert.deepEqual([cb.kind, cb.amt, cb.account_id === card, cb.review_status, cb.external_ref.startsWith('reward:')], ['income', 40, true, 'accepted', true]);
  assert.equal(r.cashbackPosted.length, 1);
  assert.equal((await a.query(`SELECT balance::float8 AS b FROM wealth_v_latest_balances WHERE account_id=$1`, [card]))[0].b, 2760, 'card owed 2000 + 800 payment - 40 cashback');
  await tx(card, 'income', 'Refund', 'Refund', 10);
  const page = await pageTransactions(uid, {}, a);
  const row = page.transactions.find(x => x.id === pay);
  assert.deepEqual(row.rewards.map(x => [x.title, x.kind, x.inr, x.status]), [['Swiggy 5%', 'cashback', 40, 'received']]);
  assert.deepEqual(page.transactions.find(x => x.id !== pay).rewards, [], 'other rows have an empty list');
  const [use] = await a.query(`SELECT used_on::text d, status, title FROM wealth_offer_uses`);
  assert.deepEqual([use.d, use.status, use.title], ['2026-11-13', 'received', 'Swiggy 5%']);
});

test('exclusive tiers: of 10% Swiggy / 5% online / 1% everything, only the best applies', async () => {
  const { a, uid, card, tx } = await setup();
  const mk = (title, merchants, v) => saveOffer(uid, { accountId: card, title, merchants, benefitType: 'percent', benefitValue: v, exclusiveGroup: 'hdfc-tier' }, { db: a });
  await mk('10% Swiggy', 'swiggy', 10); await mk('5% online', '', 5); await mk('1% everything', '', 1);
  const pay = await tx(card, 'expense', 'Food', 'Swiggy order', 1000);
  const p = (await pendingTransactions(uid, { db: a })).find(x => x.id === pay);
  assert.deepEqual(p.offers.map(o => [o.title, o.shadowed]), [['10% Swiggy', null], ['5% online', '10% Swiggy'], ['1% everything', '10% Swiggy']]);
  const r = await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.deepEqual(r.applied.map(x => x.title), ['10% Swiggy']);
  const other = await tx(card, 'expense', 'Shopping', 'Amazon', 1000);
  const r2 = await acceptTransaction(uid, { transactionId: other }, { db: a, now: NOW + 1000 });
  assert.deepEqual(r2.applied.map(x => x.title), ['5% online'], 'the 10% offer does not match, so the next best applies');
});

test('points: earned on accept, shown on the program as an estimate on top of the last balance, never counted twice', async () => {
  const { a, uid, sav, tx } = await setup();
  const programId = (await upsertRewardProgram(uid, { programKey: 'slice-monies', provider: 'Slice', name: 'Slice Monies', unit: 'Monies', inrPerUnit: 0.01, rateSource: 'Slice app, 14 Nov 2026', accountId: sav }, { db: a })).programId;
  await recordRewardBalance(uid, { programId, units: 184250, asOf: '2026-11-12T08:00:00Z', status: 'verified' }, { db: a, now: NOW });
  await saveOffer(uid, { accountId: sav, title: 'UPI monies', benefitType: 'percent', benefitValue: 1, rewardUnit: 'monies', programId, paymentMode: 'upi' }, { db: a });
  const early = await tx(sav, 'expense', 'Food', 'UPI payment to Cafe', 300, '2026-11-12');   // same day as the balance: already inside it
  const late = await tx(sav, 'expense', 'Food', 'UPI payment to Zepto', 480, '2026-11-13');
  await acceptTransaction(uid, { transactionId: early }, { db: a, now: NOW });
  await acceptTransaction(uid, { transactionId: late }, { db: a, now: NOW + 1000 });
  const earned = (await a.query(`SELECT used_on::text d, units::float8 u, benefit::float8 b, kind, program_id FROM wealth_offer_uses ORDER BY used_on`));
  assert.deepEqual(earned.map(e => [e.d, e.u, e.b, e.kind, e.program_id === programId]), [['2026-11-12', 300, 3, 'points', true], ['2026-11-13', 480, 4.8, 'points', true]]);
  const p = (await rewardsOverview(uid, { db: a, now: NOW })).programs.find(x => x.id === programId);
  assert.deepEqual([p.earned.units, p.earned.count, p.earned.estimatedUnits], [480, 1, 184730], 'only the payment after the balance day is added');
  assert.equal(p.earned.estimatedValue, 1847.3);
  assert.equal(p.offers.length, 1, 'the program lists its offers');
  // the next screenshot balance replaces the estimate
  await recordRewardBalance(uid, { programId, units: 184800, asOf: '2026-11-14T09:00:00Z', status: 'verified' }, { db: a, now: NOW });
  assert.equal((await rewardsOverview(uid, { db: a, now: NOW })).programs.find(x => x.id === programId).earned.units, 0);
});

test('cashback to receive: a matching credit is suggested, linking marks it received once, and nothing is counted twice', async () => {
  const { a, uid, other, card, tx, credit } = await setup();
  await saveOffer(uid, { accountId: card, title: 'Swiggy 5%', merchants: 'swiggy', benefitType: 'percent', benefitValue: 5 }, { db: a });
  const p1 = await tx(card, 'expense', 'Food', 'Swiggy order', 800), p2 = await tx(card, 'expense', 'Food', 'Swiggy order 2', 800, '2026-11-12');
  await acceptTransaction(uid, { transactionId: p1 }, { db: a, now: NOW }); await acceptTransaction(uid, { transactionId: p2 }, { db: a, now: NOW + 1000 });
  await legacyExpected(a);
  const cr = await credit(40, '2026-11-14');
  const e1 = await listEarnings(uid, { db: a });
  assert.equal(e1.totals.money_expected, 80);
  const suggestions = e1.earnings.filter(e => e.suggest);
  assert.equal(suggestions.length, 1, 'one credit cannot be suggested for two earnings');
  assert.equal(suggestions[0].suggest.transactionId, cr);
  const target = suggestions[0];
  assert.equal(target.used_on, '2026-11-12', 'the oldest waiting cashback of that amount claims the credit');
  await setEarningStatus(uid, { earningId: target.id, status: 'received', creditedTransactionId: cr }, { db: a });
  const after = await listEarnings(uid, { db: a });
  assert.deepEqual([after.totals.money_expected, after.totals.money_received], [40, 40]);
  assert.equal(after.earnings.filter(e => e.suggest).length, 0, 'the credit is used up');
  const other2 = after.earnings.find(e => e.status === 'expected');
  await assert.rejects(setEarningStatus(uid, { earningId: other2.id, status: 'received', creditedTransactionId: cr }, { db: a }), e => e.status === 409, 'a credit pays one earning only');
  await assert.rejects(setEarningStatus(other, { earningId: other2.id, status: 'cancelled' }, { db: a }), e => e.status === 404, 'another user cannot touch it');
  await assert.rejects(setEarningStatus(uid, { earningId: other2.id, status: 'received', creditedTransactionId: p1 }, { db: a }), e => e.status === 404, 'the credit must be an income transaction');
  await setEarningStatus(uid, { earningId: other2.id, status: 'received' }, { db: a });   // received without a linked credit (no import): still no ledger row
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE kind='income'`))[0].n, 1);
  await setEarningStatus(uid, { earningId: target.id, status: 'expected' }, { db: a });
  assert.equal((await a.query(`SELECT credited_transaction_id FROM wealth_offer_uses WHERE id=$1`, [target.id]))[0].credited_transaction_id, null, 'reopening frees the credit');
});

test('history survives: deleting an offer keeps what it earned; removing an earning frees its limits; a duplicate payment earns nothing', async () => {
  const { a, uid, card, tx } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'Welcome', benefitType: 'flat', benefitValue: 100, frequency: 'one_time' }, { db: a });
  const p1 = await tx(card, 'expense', 'Food', 'A', 500), p2 = await tx(card, 'expense', 'Food', 'B', 500);
  await acceptTransaction(uid, { transactionId: p1 }, { db: a, now: NOW });
  await legacyExpected(a);
  assert.equal((await listOffers(uid, { db: a })).offers[0].uses_count, 1);
  const [earning] = await a.query(`SELECT id FROM wealth_offer_uses`);
  await setEarningStatus(uid, { earningId: earning.id, status: 'cancelled' }, { db: a });
  assert.equal((await pendingTransactions(uid, { db: a })).find(x => x.id === p2).offers.length, 1, 'a removed earning no longer uses up the one-time offer');
  await setEarningStatus(uid, { earningId: earning.id, status: 'expected' }, { db: a });
  await deleteOffer(uid, id, { db: a });
  const [kept] = await a.query(`SELECT offer_id, title, status FROM wealth_offer_uses`);
  assert.deepEqual([kept.offer_id, kept.title, kept.status], [null, 'Welcome', 'expected'], 'history kept with its title');
  assert.equal((await earningsForTransactions(uid, [p1], { db: a })).get(p1).length, 1);
  // duplicate
  const { id: id2 } = await saveOffer(uid, { accountId: card, title: 'Again', benefitType: 'flat', benefitValue: 7 }, { db: a });
  const d1 = await tx(card, 'expense', 'Food', 'Dup', 250), d2 = await tx(card, 'expense', 'Food', 'Dup', 250);
  await acceptTransaction(uid, { transactionId: d1 }, { db: a, now: NOW + 1000 });
  await markDuplicate(uid, { transactionId: d1, duplicateOf: d2 }, { db: a });
  assert.equal((await a.query(`SELECT status FROM wealth_offer_uses WHERE transaction_id=$1`, [d1]))[0].status, 'cancelled');
  assert.ok(id2);
});

test('apply offers to a payment accepted earlier; refuses pending, dismissed and duplicate payments', async () => {
  const { a, uid, card, tx } = await setup();
  const pay = await tx(card, 'expense', 'Food', 'Swiggy order', 400);
  await assert.rejects(applyOffersToTransaction(uid, { transactionId: pay }, { db: a }), e => e.status === 409, 'accept first');
  await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });     // no offers exist yet
  assert.deepEqual((await applyOffersToTransaction(uid, { transactionId: pay }, { db: a })).applied, []);
  await saveOffer(uid, { accountId: card, title: 'Swiggy 5%', merchants: 'swiggy', benefitType: 'percent', benefitValue: 5 }, { db: a });
  const r = await applyOffersToTransaction(uid, { transactionId: pay }, { db: a });
  assert.deepEqual(r.applied.map(x => x.inr), [20]);
  assert.deepEqual((await applyOffersToTransaction(uid, { transactionId: pay }, { db: a })).applied, [], 'applying twice does not add a second earning');
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_offer_uses`))[0].n, 1);
});

test('validation of the new offer fields', async () => {
  const { a, uid, sav, card } = await setup();
  const ok = { accountId: card, title: 'T', benefitType: 'percent', benefitValue: 5 };
  for (const bad of [{ benefitType: 'per_block' }, { benefitType: 'per_block', blockAmount: 0 }, { minSpend: 500, maxSpend: 100 }, { maxSpend: 0 }, { applyMode: 'sometimes' },
    { rewardUnit: 'points' }, { rewardUnit: 'points', programId: 'nope' }, { benefitType: 'weekly' }])
    await assert.rejects(saveOffer(uid, { ...ok, ...bad }, { db: a }), e => e.status === 400, JSON.stringify(bad));
  const noRate = (await upsertRewardProgram(uid, { programKey: 'norate', provider: 'X', name: 'X pts', unit: 'points', accountId: card }, { db: a })).programId;
  await assert.rejects(saveOffer(uid, { ...ok, rewardUnit: 'points', programId: noRate }, { db: a }), e => e.status === 400 && /per block|rate/i.test(e.message), 'percent of points needs a rate');
  assert.ok((await saveOffer(uid, { ...ok, rewardUnit: 'points', programId: noRate, benefitType: 'per_block', benefitValue: 4, blockAmount: 150 }, { db: a })).saved);
  assert.ok((await saveOffer(uid, { ...ok, maxSpend: 5000, minSpend: 100, applyMode: 'ask', exclusiveGroup: 'g', preset: 'spark' }, { db: a })).saved);
  const [row] = (await listOffers(uid, { db: a })).offers.filter(o => o.preset === 'spark');
  assert.deepEqual([row.max_spend, row.min_spend, row.apply_mode, row.exclusive_group], [5000, 100, 'ask', 'g']);
  assert.ok(sav);
});

test('wiring: routes, menu gating and the migration is additive', () => {
  assert.match(read('api/router.js'), /'offer-earnings': \(\) => import/);
  assert.match(read('api/_roles.js'), /'offer-earnings': \['rewards', 'transactions', 'offers', 'overview'\]/);
  const m = read('scripts/migrations/0032_offer_earnings.sql');
  assert.doesNotMatch(m, /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM|DROP COLUMN/i);
  assert.match(m, /ON DELETE SET NULL/);
  assert.match(read('api/_routes/transaction-accept.js'), /apply_offers/);
});

// ---- fixes from the independent review (2026-11-14) ----
import { deleteTransaction, undoLastUse } from '../../api/_offers.js';

test('deleting a payment cancels what it earned: nothing is counted, its credit is freed, the one-time offer is available again', async () => {
  const { a, uid, card, tx, credit } = await setup();
  await saveOffer(uid, { accountId: card, title: 'Welcome', benefitType: 'flat', benefitValue: 100, frequency: 'one_time' }, { db: a });
  const p1 = await tx(card, 'expense', 'Food', 'A', 500), p2 = await tx(card, 'expense', 'Food', 'B', 500);
  await acceptTransaction(uid, { transactionId: p1 }, { db: a, now: NOW });
  const cr = await credit(100, '2026-11-14');
  const [e] = (await listEarnings(uid, { db: a })).earnings;
  await setEarningStatus(uid, { earningId: e.id, status: 'received', creditedTransactionId: cr }, { db: a });
  assert.equal((await pendingTransactions(uid, { db: a })).find(x => x.id === p2).offers.length, 0, 'the one-time offer is used');
  assert.equal((await deleteTransaction(uid, p1, { db: a })).length, 1);
  const [row] = await a.query(`SELECT status, credited_transaction_id, transaction_id FROM wealth_offer_uses`);
  assert.deepEqual([row.status, row.credited_transaction_id, row.transaction_id], ['cancelled', null, null]);
  const t = (await listEarnings(uid, { db: a })).totals;
  assert.deepEqual([t.money_expected, t.money_received], [0, 0]);
  assert.equal((await pendingTransactions(uid, { db: a })).find(x => x.id === p2).offers.length, 1, 'the offer is free again');
  assert.equal((await deleteTransaction(other(a), p2, { db: a }).catch(() => [])).length, 0);
});
const other = () => '00000000-0000-4000-8000-000000000000';

test('undoing a received earning frees its credit so it can be suggested and linked again', async () => {
  const { a, uid, card, tx, credit } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'Swiggy 5%', merchants: 'swiggy', benefitType: 'percent', benefitValue: 5 }, { db: a });
  const p = await tx(card, 'expense', 'Food', 'Swiggy order', 1000);
  await acceptTransaction(uid, { transactionId: p }, { db: a, now: NOW });
  await legacyExpected(a);
  const cr = await credit(50, '2026-11-14');
  const [e] = (await listEarnings(uid, { db: a })).earnings;
  await setEarningStatus(uid, { earningId: e.id, status: 'received', creditedTransactionId: cr }, { db: a });
  await undoLastUse(uid, id, { db: a });
  assert.equal((await a.query(`SELECT credited_transaction_id FROM wealth_offer_uses`))[0].credited_transaction_id, null);
  await applyOffersToTransaction(uid, { transactionId: p }, { db: a });          // the cancelled earning comes back
  await legacyExpected(a);                                                       // (as an old-style expected one)
  const again = (await listEarnings(uid, { db: a })).earnings.find(x => x.status === 'expected');
  assert.equal(again.suggest.transactionId, cr, 'the credit is suggested again');
  await setEarningStatus(uid, { earningId: again.id, status: 'received', creditedTransactionId: cr }, { db: a });
});

test('cashback still to arrive is never cut off by the list limit; the header total and the list agree', async () => {
  const { a, uid, card, sav, tx } = await setup();
  const prog = (await upsertRewardProgram(uid, { programKey: 'pts', provider: 'X', name: 'X points', unit: 'points', accountId: sav }, { db: a })).programId;
  await saveOffer(uid, { accountId: card, title: 'Cash', benefitType: 'flat', benefitValue: 10, merchants: 'old' }, { db: a });
  await saveOffer(uid, { accountId: sav, title: 'Points', benefitType: 'flat', benefitValue: 1, rewardUnit: 'points', programId: prog }, { db: a });
  const old = await tx(card, 'expense', 'Food', 'old order', 300, '2026-10-01');
  await acceptTransaction(uid, { transactionId: old }, { db: a, now: NOW });
  await legacyExpected(a);
  for (let i = 0; i < 35; i++) await acceptTransaction(uid, { transactionId: await tx(sav, 'expense', 'Food', 'p' + i, 100 + i, '2026-11-1' + (i % 4)) }, { db: a, now: NOW + 1000 + i });
  const r = await listEarnings(uid, { db: a, limit: 30 });
  assert.equal(r.totals.money_expected, 10);
  assert.equal(r.earnings.filter(e => e.status === 'expected' && e.kind === 'cashback').length, 1, 'the old cashback is listed although 35 newer points earnings exist');
  assert.ok(r.earnings.length <= 31);
});

test('an "ask me" offer never hides the automatic one of its group; two rewards = the owner chooses, and may map both', async () => {
  const { a, uid, card, tx } = await setup();
  const mk = (title, v, applyMode) => saveOffer(uid, { accountId: card, title, benefitType: 'percent', benefitValue: v, exclusiveGroup: 'tiers', applyMode }, { db: a });
  const { id: auto } = await mk('1% auto', 1, 'auto'), { id: ask } = await mk('Spark 20% (ask)', 20, 'ask');
  const pay = await tx(card, 'expense', 'Food', 'Zepto', 1000);
  const m = (await pendingTransactions(uid, { db: a })).find(x => x.id === pay).offers;
  assert.deepEqual(m.map(o => [o.title, o.shadowed]), [['Spark 20% (ask)', null], ['1% auto', null]], 'neither is shadowed in the preview');
  const r = await acceptTransaction(uid, { transactionId: pay }, { db: a, now: NOW });
  assert.deepEqual(r.applied, [], 'two rewards are available: nothing is mapped by itself');
  assert.equal(r.needsChoice, true);
  const p2 = await tx(card, 'expense', 'Food', 'Zepto 2', 1000);
  const r2 = await acceptTransaction(uid, { transactionId: p2, applyOfferIds: [auto, ask] }, { db: a, now: NOW + 1000 });
  assert.deepEqual(r2.applied.map(x => x.title).sort(), ['1% auto', 'Spark 20% (ask)'], 'the owner ticked both: both are mapped');
});

test('a card repayment or EMI (liability) earns nothing, spending does', async () => {
  const { a, uid, card, tx } = await setup();
  await saveOffer(uid, { accountId: card, title: '1% on everything', benefitType: 'percent', benefitValue: 1 }, { db: a });
  const bill = await tx(card, 'liability', 'Card payment', 'HDFC card bill', 50000);
  const spend = await tx(card, 'expense', 'Food', 'Lunch', 500);
  const p = await pendingTransactions(uid, { db: a });
  assert.equal(p.find(x => x.id === bill).offers.length, 0);
  assert.equal(p.find(x => x.id === spend).offers.length, 1);
});

test('starting templates carry no rate, amount or limit', () => {
  const presets = vm.runInContext('OF_PRESETS', loadUi());
  for (const p of presets) for (const k of ['benefitValue', 'maxBenefit', 'minSpend', 'maxSpend', 'blockAmount', 'periodMaxBenefit', 'periodMaxUses', 'cycleDay', 'maxUses'])
    assert.ok(!(k in p.fill), p.key + ' must not set ' + k);
});
import vm from 'node:vm';
function loadUi() {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const ctx = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]), money: v => '₹' + Number(v).toFixed(2), api: async () => ({}), alert() {}, confirm: () => true, activeView: 'x',
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } }, Number, String, Date, Math, Object, JSON, Array, Set, Intl, console, setTimeout };
  vm.createContext(ctx); vm.runInContext(read('offers.js'), ctx); return ctx;
}
