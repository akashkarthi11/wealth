// 2026-11-14 (migrations 0028-0030): assistant balances are unverified until confirmed in Data quality; Accept writes a new balance
// on the source account and finds that account's offers; Account offers are kept on a screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { collectIssues } from '../../api/_dataquality.js';
import { confirmBalance, rejectBalance } from '../../api/_balancereview.js';
import { pendingTransactions, acceptTransaction, dismissTransaction, signedDelta } from '../../api/_accept.js';
import { saveOffer, listOffers, deleteOffer, matchOffers, offerBenefit, activeOffersFor } from '../../api/_offers.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const sav = (await createAccount(u.id, { subtype: 'savings', institution: 'HDFC', name: 'Savings', maskedIdentifier: '1111' }, { db: a })).account.id;
  const card = (await createAccount(u.id, { subtype: 'credit_card', institution: 'HDFC', name: 'Swiggy Card', maskedIdentifier: '2222' }, { db: a })).account.id;
  const demat = (await createAccount(u.id, { subtype: 'demat_equity', institution: 'Broker', name: 'Demat' }, { db: a })).account.id;
  await recordBalance(u.id, { accountId: sav, balance: 10000, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
  await recordBalance(u.id, { accountId: card, balance: 2000, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: NOW });
  const tx = async (accountId, kind, category, description, amount, day = '2026-11-13') =>
    (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,$2,$3,$4,$5,'',$6,$7) RETURNING id`, [u.id, kind, category, description, amount, accountId, day]))[0].id;
  const latest = async id => (await a.query(`SELECT x.balance::float8 b, x.status, x.entered_by FROM wealth_account_balances x WHERE x.account_id=$1 AND x.rejected_at IS NULL ORDER BY x.as_of DESC LIMIT 1`, [id]))[0];
  return { a, uid: u.id, other: o.id, sav, card, demat, tx, latest };
}

test('assistant (agent) balance is stored as reported, not verified, and listed in Data quality; the owner\'s own stays verified', async () => {
  const { a, uid, sav, card, latest } = await setup();
  const r = await recordBalance(uid, { accountId: sav, balance: 12345.5, asOf: '2026-11-12T08:00:00Z', status: 'verified' }, { db: a, actor: 'agent', now: NOW });
  assert.equal(r.status, 'reported'); assert.equal(r.needsReview, true);
  const l = await latest(sav);
  assert.deepEqual([l.b, l.status, l.entered_by], [12345.5, 'reported', 'agent']);
  const legacy = (await a.query(`SELECT current_balance::float8 b, balance_status FROM wealth_accounts WHERE id=$1`, [sav]))[0];
  assert.deepEqual([legacy.b, legacy.balance_status], [12345.5, 'stale'], 'dashboard still shows the new number, marked not verified (stale = unverified)');
  await recordBalance(uid, { accountId: card, balance: 2500, asOf: '2026-11-12T08:00:00Z', status: 'verified' }, { db: a, actor: 'owner', now: NOW });
  assert.equal((await latest(card)).status, 'verified');
  const dq = await collectIssues(uid, { db: a, now: NOW, env: {} });
  const issues = dq.issues.filter(i => i.category === 'balance_review');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /not verified yet/);
  assert.equal(issues[0].evidence.previous.balance, 10000);
});

test('Confirm makes it verified; Reject uses the previous balance again and keeps the row', async () => {
  const { a, uid, other, sav, latest } = await setup();
  await recordBalance(uid, { accountId: sav, balance: 12000, asOf: '2026-11-12T08:00:00Z' }, { db: a, actor: 'agent', now: NOW });
  await assert.rejects(confirmBalance(other, { accountId: sav, asOf: '2026-11-12T08:00:00Z' }, { db: a }), e => e.status === 404);
  await confirmBalance(uid, { accountId: sav, asOf: '2026-11-12T08:00:00Z' }, { db: a });
  assert.equal((await latest(sav)).status, 'verified');
  assert.equal((await a.query(`SELECT balance_status FROM wealth_accounts WHERE id=$1`, [sav]))[0].balance_status, 'verified');
  assert.equal((await collectIssues(uid, { db: a, now: NOW, env: {} })).issues.filter(i => i.category === 'balance_review').length, 0);
  await assert.rejects(confirmBalance(uid, { accountId: sav, asOf: '2026-11-12T08:00:00Z' }, { db: a }), e => e.status === 404, 'only once');
  // reject path
  await recordBalance(uid, { accountId: sav, balance: 999, asOf: '2026-11-13T08:00:00Z' }, { db: a, actor: 'agent', now: NOW });
  await rejectBalance(uid, { accountId: sav, asOf: '2026-11-13T08:00:00Z', reason: 'misread' }, { db: a });
  assert.equal((await latest(sav)).b, 12000);
  assert.equal((await a.query(`SELECT current_balance::float8 b FROM wealth_accounts WHERE id=$1`, [sav]))[0].b, 12000, 'dashboard column restored');
  const kept = (await a.query(`SELECT rejected_reason FROM wealth_account_balances WHERE balance=999`))[0];
  assert.equal(kept.rejected_reason, 'misread');
});

test('interest still starts from an assistant balance (reported by agent counts as the base until rejected)', async () => {
  const { isBase } = await import('../../api/_interest.js');
  assert.equal(isBase({ status: 'verified' }), true);
  assert.equal(isBase({ status: 'reported', entered_by: 'agent' }), true);
  assert.equal(isBase({ status: 'reported', entered_by: 'accept' }), true);
  assert.equal(isBase({ status: 'reported', entered_by: 'user' }), false);
  assert.equal(isBase({ status: 'pending_reconciliation', entered_by: 'agent' }), false);
});

test('new transactions wait as pending; old ones (no review status) never do', async () => {
  const { a, uid, sav, tx } = await setup();
  const id = await tx(sav, 'expense', 'Food', 'Lunch', 450);
  assert.equal((await a.query(`SELECT review_status FROM wealth_transactions WHERE id=$1`, [id]))[0].review_status, 'pending');
  await a.query(`UPDATE wealth_transactions SET review_status=NULL WHERE id=$1`, [id]);
  assert.deepEqual(await pendingTransactions(uid, { db: a }), []);
});

test('signed amounts: bank spend reduces, income increases, transfer by name; card spend adds owed, payment reduces; demat has no balance', () => {
  const s = (acctCategory, kind, category = '', valuation = 'balance') => signedDelta({ acctCategory, valuation, kind, category, amount: 100 }).delta;
  assert.equal(s('CASA', 'expense'), -100); assert.equal(s('CASA', 'income'), 100); assert.equal(s('CASA', 'investment'), -100); assert.equal(s('CASA', 'liability'), -100);
  assert.equal(s('CASA', 'transfer', 'Transfer sent'), -100); assert.equal(s('CASA', 'transfer', 'Transfer received'), 100);
  assert.equal(s('LIABILITY', 'expense'), 100); assert.equal(s('LIABILITY', 'income'), -100); assert.equal(s('LIABILITY', 'transfer', 'Card payment'), -100);
  assert.equal(s('LIABILITY', 'transfer', 'Transfer sent'), null);
  assert.equal(s('INVESTMENT', 'expense', '', 'holdings'), null);
});

test('Accept: the source account balance goes down / up, once, and the new balance is the one shown', async () => {
  const { a, uid, sav, card, tx, latest } = await setup();
  const spend = await tx(sav, 'expense', 'Food', 'Lunch', 450);
  const salary = await tx(sav, 'income', 'Salary', 'Pay', 5000);
  const swiggy = await tx(card, 'expense', 'Food', 'Swiggy order', 800);
  const p = await pendingTransactions(uid, { db: a });
  const lunch = p.find(x => x.id === spend);
  assert.deepEqual([lunch.balance, lunch.delta, lunch.after], [10000, -450, 9550]);
  const r1 = await acceptTransaction(uid, { transactionId: spend }, { db: a, now: NOW });
  assert.deepEqual([r1.before, r1.after], [10000, 9550]);
  assert.deepEqual((({ b, status, entered_by }) => [b, status, entered_by])(await latest(sav)), [9550, 'reported', 'accept']);
  await acceptTransaction(uid, { transactionId: salary }, { db: a, now: NOW + 1000 });
  assert.equal((await latest(sav)).b, 14550);
  assert.equal((await a.query(`SELECT current_balance::float8 b FROM wealth_accounts WHERE id=$1`, [sav]))[0].b, 14550, 'dashboard column in step');
  await acceptTransaction(uid, { transactionId: swiggy }, { db: a, now: NOW + 2000 });
  assert.equal((await latest(card)).b, 2800, 'card owes more');
  await assert.rejects(acceptTransaction(uid, { transactionId: spend }, { db: a, now: NOW + 3000 }), e => e.status === 409, 'not twice');
  assert.equal((await latest(sav)).b, 14550);
  assert.equal((await a.query(`SELECT review_status FROM wealth_transactions WHERE id=$1`, [spend]))[0].review_status, 'accepted');
});

test('Accept refuses what it cannot do: no balance yet, no balance concept, other user\'s transaction; Dismiss leaves the balance', async () => {
  const { a, uid, other, sav, demat, tx, latest } = await setup();
  const [empty] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'nobal','X','No balance','savings','savings','INR') RETURNING id`, [uid]);
  const noBal = await tx(empty.id, 'expense', 'Food', 'x', 10);
  const inDemat = await tx(demat, 'expense', 'Food', 'y', 10);
  const mine = await tx(sav, 'expense', 'Food', 'z', 10);
  await assert.rejects(acceptTransaction(uid, { transactionId: noBal }, { db: a }), e => e.status === 409);
  await assert.rejects(acceptTransaction(uid, { transactionId: inDemat }, { db: a }), e => e.status === 400);
  await assert.rejects(acceptTransaction(other, { transactionId: mine }, { db: a }), e => e.status === 404);
  await assert.rejects(dismissTransaction(other, { transactionId: mine }, { db: a }), e => e.status === 404);
  await dismissTransaction(uid, { transactionId: mine }, { db: a });
  assert.equal((await latest(sav)).b, 10000);
  assert.ok(!(await pendingTransactions(uid, { db: a })).some(p => p.id === mine));
  const p = await pendingTransactions(uid, { db: a });
  assert.ok(p.find(x => x.id === noBal).cannot && p.find(x => x.id === inDemat).cannot);
});

test('offers: saved per account, matched by account + payee + dates + minimum, benefit capped; accept returns them', async () => {
  const { a, uid, other, sav, card, tx } = await setup();
  const base = { accountId: card, title: 'HDFC Swiggy — Swiggy', merchants: 'Swiggy, Instamart', benefitType: 'percent', benefitValue: 10, maxBenefit: 150, minSpend: 200, rewardUnit: 'cashback', validFrom: '2026-11-01', validTo: '2026-12-31', sourceUrl: 'https://example.test/offer' };
  const { id } = await saveOffer(uid, base, { db: a });
  await saveOffer(uid, { ...base, title: 'Other card flat', accountId: sav, merchants: 'swiggy', benefitType: 'flat', benefitValue: 50, maxBenefit: '' }, { db: a });
  await saveOffer(uid, { ...base, title: 'Any payment', merchants: '', benefitType: 'flat', benefitValue: 5, maxBenefit: '', minSpend: '' }, { db: a });
  const { offers, uses } = await activeOffersFor(uid, [card], { db: a });
  const t = { account_id: card, kind: 'expense', category: 'Food', description: 'SWIGGY ORDER 123', amount: 800, occurred_on: '2026-11-13' };
  assert.deepEqual(matchOffers(offers, t, uses).map(o => [o.title, o.expected]), [['HDFC Swiggy — Swiggy', 80], ['Any payment', 5]]);
  assert.equal(matchOffers(offers, { ...t, amount: 5000 }, uses)[0].expected, 150, 'capped at 150');
  assert.deepEqual(matchOffers(offers, { ...t, description: 'Amazon' }, uses).map(o => o.title), ['Any payment'], 'payee must match');
  assert.deepEqual(matchOffers(offers, { ...t, amount: 100 }, uses).map(o => o.title), ['Any payment'], 'minimum spend');
  assert.deepEqual(matchOffers(offers, { ...t, occurred_on: '2027-01-02' }, uses).map(o => o.title), [], 'expired');
  assert.deepEqual(matchOffers(offers, { ...t, kind: 'income' }, uses), [], 'only payments out');
  assert.equal(matchOffers(offers, { ...t, account_id: sav }, uses).length, 0, 'another account\'s offers are not used');
  assert.equal(offerBenefit({ benefit_type: 'flat', benefit_value: 30, max_benefit: 20 }, 1), 20);
  const spend = await tx(card, 'expense', 'Food', 'Swiggy dinner', 600);
  const pend = (await pendingTransactions(uid, { db: a })).find(x => x.id === spend);
  assert.equal(pend.offers[0].expected, 60);
  const acc = await acceptTransaction(uid, { transactionId: spend }, { db: a, now: NOW });
  assert.equal(acc.offers[0].title, 'HDFC Swiggy — Swiggy');
  // off switch, edit, isolation, delete
  await saveOffer(uid, { ...base, id, active: false }, { db: a });
  assert.equal((await activeOffersFor(uid, [card], { db: a })).offers.some(o => o.id === id), false);
  await assert.rejects(saveOffer(other, { ...base, id }, { db: a }), e => e.status === 404);
  await assert.rejects(saveOffer(other, base, { db: a }), e => e.status === 404, 'not their account');
  assert.equal((await listOffers(other, { db: a })).offers.length, 0);
  await assert.rejects(deleteOffer(other, id, { db: a }), e => e.status === 404);
  await deleteOffer(uid, id, { db: a });
  assert.equal((await listOffers(uid, { db: a })).offers.length, 2);
});

test('offer validation', async () => {
  const { a, uid, card } = await setup();
  const ok = { accountId: card, title: 'T', benefitType: 'percent', benefitValue: 5 };
  for (const bad of [{ title: '' }, { benefitType: 'x' }, { benefitValue: 0 }, { benefitValue: 150 }, { maxBenefit: -1 }, { validFrom: '2026-12-01', validTo: '2026-11-01' }, { validFrom: 'soon' }, { sourceUrl: 'javascript:alert(1)' }, { rewardUnit: 'gold' }, { accountId: 'nope' }])
    await assert.rejects(saveOffer(uid, { ...ok, ...bad }, { db: a }), e => e.status === 400, JSON.stringify(bad));
  assert.ok((await saveOffer(uid, ok, { db: a })).saved);
});

test('wiring: routes, menu, roles and screens', () => {
  const router = read('api/router.js'), roles = read('api/_roles.js'), app = read('app.js');
  assert.match(router, /'transaction-accept': \(\) => import/); assert.match(router, /'account-offers': \(\) => import/);
  assert.match(roles, /key: 'offers', label: 'Account offers'/); assert.match(roles, /'account-offers': \['offers'\]/); assert.match(roles, /'transaction-accept': \['transactions', 'overview'\]/);
  for (const s of ['loadPendingTx', 'data-tx-accept', 'balanceReviewRowHtml', 'data-bal-confirm', '/api/account-offers', "view==='offers'", 'data-offer-add']) assert.ok(app.includes(s), s);
  assert.match(read('index.html'), /data-view="offers"/);
  assert.match(read('api/_routes/data-quality.js'), /confirm_balance/);
  for (const m of ['0028_balance_review', '0029_transaction_review', '0030_account_offers']) assert.doesNotMatch(read(`scripts/migrations/${m}.sql`), /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM/i);
});

// ---- every kind of offer: one-time, limited, per period caps, UPI, card, weekdays, coupon ----
import { periodWindow, offerStanding, undoLastUse } from '../../api/_offers.js';

test('period windows: day, week (Monday), month, year and a billing cycle that starts on the statement day', () => {
  assert.deepEqual(periodWindow('day', null, '2026-11-14'), ['2026-11-14', '2026-11-15']);
  assert.deepEqual(periodWindow('week', null, '2026-11-14'), ['2026-11-09', '2026-11-16'], 'Saturday belongs to the week starting Monday 9 Nov');
  assert.deepEqual(periodWindow('month', null, '2026-11-14'), ['2026-11-01', '2026-12-01']);
  assert.deepEqual(periodWindow('year', null, '2026-11-14'), ['2026-01-01', '2027-01-01']);
  assert.deepEqual(periodWindow('cycle', 10, '2026-11-14'), ['2026-11-10', '2026-12-10']);
  assert.deepEqual(periodWindow('cycle', 10, '2026-11-05'), ['2026-10-10', '2026-11-10']);
  assert.deepEqual(periodWindow('cycle', 20, '2026-01-05'), ['2025-12-20', '2026-01-20'], 'across the year end');
  assert.equal(periodWindow('none', null, '2026-11-14'), null);
});

test('one-time offer: usable once; after it is used it no longer matches; Undo brings it back', async () => {
  const { a, uid, card, tx } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'Welcome 100', merchants: 'swiggy', benefitType: 'flat', benefitValue: 100, frequency: 'one_time', couponCode: 'WELCOME100' }, { db: a });
  const t1 = await tx(card, 'expense', 'Food', 'Swiggy order', 400, '2026-11-12');
  const t2 = await tx(card, 'expense', 'Food', 'Swiggy order 2', 400, '2026-11-13');
  let p = await pendingTransactions(uid, { db: a });
  assert.equal(p.find(x => x.id === t1).offers[0].couponCode, 'WELCOME100');
  assert.equal(p.find(x => x.id === t1).offers[0].oneTime, true);
  const r = await acceptTransaction(uid, { transactionId: t1, usedOfferIds: [id] }, { db: a, now: NOW });
  assert.deepEqual(r.usedOffers.map(u => [u.title, u.benefit]), [['Welcome 100', 100]]);
  p = await pendingTransactions(uid, { db: a });
  assert.deepEqual(p.find(x => x.id === t2).offers, [], 'used up');
  assert.equal((await listOffers(uid, { db: a })).offers[0].standing.exhausted, 'used up');
  await undoLastUse(uid, id, { db: a });
  p = await pendingTransactions(uid, { db: a });
  assert.equal(p.find(x => x.id === t2).offers.length, 1);
  await assert.rejects(undoLastUse(uid, id, { db: a }), e => e.status === 404);
});

test('a one-time offer cannot be used twice even if two payments are ticked; an offer that does not match is not recorded', async () => {
  const { a, uid, card, sav, tx } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'Once', benefitType: 'flat', benefitValue: 50, frequency: 'one_time' }, { db: a });
  const t1 = await tx(card, 'expense', 'Food', 'A', 100), t2 = await tx(card, 'expense', 'Food', 'B', 100);
  assert.equal((await acceptTransaction(uid, { transactionId: t1, usedOfferIds: [id] }, { db: a, now: NOW })).usedOffers.length, 1);
  assert.equal((await acceptTransaction(uid, { transactionId: t2, usedOfferIds: [id] }, { db: a, now: NOW + 1000 })).usedOffers.length, 0);
  const t3 = await tx(sav, 'expense', 'Food', 'C', 100);
  assert.equal((await acceptTransaction(uid, { transactionId: t3, usedOfferIds: [id] }, { db: a, now: NOW + 2000 })).usedOffers.length, 0, 'other account');
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_offer_uses`))[0].n, 1);
});

test('limited offer: 3 uses in total', async () => {
  const { a, uid, card } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'First 3', benefitType: 'percent', benefitValue: 10, frequency: 'limited', maxUses: 3 }, { db: a });
  const { offers } = await activeOffersFor(uid, [card], { db: a });
  const uses = n => Array.from({ length: n }, (_, i) => ({ offer_id: id, used_on: '2026-11-0' + (i + 1), benefit: 10 }));
  const t = { account_id: card, kind: 'expense', category: 'x', description: 'y', amount: 100, occurred_on: '2026-11-14' };
  assert.equal(matchOffers(offers, t, uses(2))[0].usesLeftTotal, 1);
  assert.equal(matchOffers(offers, t, uses(3)).length, 0);
  await assert.rejects(saveOffer(uid, { accountId: card, title: 'x', benefitType: 'flat', benefitValue: 1, frequency: 'limited' }, { db: a }), e => e.status === 400, 'needs a number');
});

test('per-period limits: HDFC Swiggy style 1,500 per billing cycle, and N uses per month', async () => {
  const { a, uid, card } = await setup();
  const { id } = await saveOffer(uid, { accountId: card, title: 'Swiggy 10%', merchants: 'swiggy', benefitType: 'percent', benefitValue: 10, minSpend: 249, period: 'cycle', cycleDay: 10, periodMaxBenefit: 1500 }, { db: a });
  const { offers } = await activeOffersFor(uid, [card], { db: a });
  const t = { account_id: card, kind: 'expense', category: 'Food', description: 'Swiggy', amount: 8000, occurred_on: '2026-11-14' };
  const used = (day, benefit) => ({ offer_id: id, used_on: day, benefit });
  assert.equal(matchOffers(offers, t, [])[0].expected, 800);
  assert.equal(matchOffers(offers, t, [used('2026-11-11', 1000)])[0].expected, 500, 'only 500 left of the 1,500 cycle cap');
  assert.equal(matchOffers(offers, t, [used('2026-11-11', 1500)]).length, 0, 'cap reached');
  assert.equal(matchOffers(offers, t, [used('2026-11-09', 1500)])[0].expected, 800, 'the previous cycle (ended 9 Nov) does not count');
  assert.equal(matchOffers(offers, { ...t, amount: 200 }, []).length, 0, 'below the 249 minimum');
  const monthly = { ...offers[0], period: 'month', period_max_uses: 2, period_max_benefit: null, cycle_day: null };
  assert.equal(offerStanding(monthly, [used('2026-11-02', 5), used('2026-11-03', 5)], '2026-11-14').exhausted, 'period limit reached');
  assert.equal(offerStanding(monthly, [used('2026-10-02', 5), used('2026-10-03', 5)], '2026-11-14').exhausted, null, 'last month does not count');
  await assert.rejects(saveOffer(uid, { accountId: card, title: 'x', benefitType: 'flat', benefitValue: 1, period: 'cycle', periodMaxBenefit: 100 }, { db: a }), e => e.status === 400, 'cycle needs a statement day');
  await assert.rejects(saveOffer(uid, { accountId: card, title: 'x', benefitType: 'flat', benefitValue: 1, period: 'month' }, { db: a }), e => e.status === 400, 'a period needs a limit');
});

test('UPI offers (Slice UPI), credit-card-only offers, and weekday offers', async () => {
  const { a, uid, sav, card } = await setup();
  await saveOffer(uid, { accountId: sav, title: 'UPI cashback', benefitType: 'percent', benefitValue: 2, paymentMode: 'upi', rewardUnit: 'monies' }, { db: a });
  await saveOffer(uid, { accountId: card, title: 'Card only', benefitType: 'flat', benefitValue: 10, paymentMode: 'card' }, { db: a });
  await saveOffer(uid, { accountId: sav, title: 'Weekend', benefitType: 'flat', benefitValue: 7, weekdays: [0, 6] }, { db: a });
  const s = (await activeOffersFor(uid, [sav], { db: a })), c = (await activeOffersFor(uid, [card], { db: a }));
  const base = { kind: 'expense', category: 'Food', amount: 500, occurred_on: '2026-11-13' };   // Friday
  assert.deepEqual(matchOffers(s.offers, { ...base, account_id: sav, description: 'UPI payment to Cafe' }, []).map(o => o.title), ['UPI cashback']);
  assert.deepEqual(matchOffers(s.offers, { ...base, account_id: sav, description: 'Cafe' }, []).map(o => o.title), [], 'not a UPI payment');
  assert.deepEqual(matchOffers(s.offers, { ...base, account_id: sav, description: 'UPI to Cafe', occurred_on: '2026-11-14' }, []).map(o => o.title).sort(), ['UPI cashback', 'Weekend'], 'Saturday');
  assert.deepEqual(matchOffers(c.offers, { ...base, account_id: card, subtype_code: 'credit_card', description: 'x' }, []).map(o => o.title), ['Card only']);
  assert.deepEqual(matchOffers(c.offers, { ...base, account_id: card, subtype_code: 'savings', description: 'x' }, []).map(o => o.title), []);
  assert.equal((await listOffers(uid, { db: a })).offers.find(o => o.title === 'UPI cashback').reward_unit, 'monies');
});

test('wiring: usage tracking in the screen and the route', () => {
  const app = read('app.js');
  for (const s of ['data-offer-use', 'data-offer-undo', 'One-time only', 'Statement day', 'Paid by UPI', 'usedOfferIds']) assert.ok(app.includes(s), s);
  assert.match(read('api/_routes/account-offers.js'), /undo_use/);
});
