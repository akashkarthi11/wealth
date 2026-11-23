// Every reward says where it goes (2026-11-15): cashback -> an account, points -> their reward program, discount / coupon -> nothing is credited.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount, recordBalance } from '../../api/_ingest.js';
import { acceptTransaction } from '../../api/_accept.js';
import { saveOffer, earningsForTransactions, activeOffersFor, matchOffers } from '../../api/_offers.js';
import { upsertRewardProgram } from '../../api/_rewards.js';

const ui = readFileSync(new URL('../../offers.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = ui.slice(ui.indexOf('// ---- reward target (start)'), ui.indexOf('// ---- reward target (end)'));
const helpers = (acctList = []) => {
  const ctx = { accounts: acctList, esc: s => String(s ?? ''), ofAcct: a => a.bank_name + ' · ' + a.account_name, ofRecvOptions: (sel, fb) => '<option>sel=' + sel + ' fb=' + fb + '</option>' };
  vm.createContext(ctx); vm.runInContext(block + '\nthis.html = ofTargetHtml; this.phrase = ofTargetPhrase; this.name = ofAcctName;', ctx);
  return ctx;
};
const accts = [{ id: 'sav1', bank_name: 'Slice', account_name: 'Slice Savings' }, { id: 'card1', bank_name: 'Slice', account_name: 'Slice Credit Card' }];

test('cashback: "Goes to" with the receiving account to choose (default the offer\'s account, else the paying account)', () => {
  const h = helpers(accts);
  const out = h.html({ id: 'o1', kind: 'cashback' }, 'data-of-recv', 'sav1', 'card1');
  assert.match(out, /Goes to <select data-of-recv="o1">/);
  assert.match(out, /sel=sav1 fb=card1/);
  assert.match(h.html({ id: 'o1', kind: 'cashback' }, 'data-of-recv', null, 'card1'), /sel=null fb=card1/, 'no receiving account on the offer: the paying account is the default');
});

test('points: the program they go to, and the account it is linked to', () => {
  const h = helpers(accts);
  assert.equal(h.html({ id: 'o2', kind: 'points', programName: 'Slice Monies', programAccountId: 'sav1' }, 'data-of-recv', null, 'card1'),
    '<div class="pd-recv pd-target">Points go to <b>Slice Monies</b> · linked to Slice · Slice Savings</div>');
  assert.match(h.html({ id: 'o2', kind: 'points', programUnit: 'Monies' }, 'x', null, null), /Points go to <b>Monies<\/b><\/div>/, 'no linked account: the program only');
  assert.doesNotMatch(h.html({ id: 'o2', kind: 'points', programName: 'P' }, 'x', null, null), /<select/, 'points have no account to choose');
});

test('discount and coupon say nothing is credited; after Accept the result names the target', () => {
  const h = helpers(accts);
  assert.match(h.html({ id: 'o3', kind: 'discount' }, 'x', null, null), /Saved at payment: nothing is credited/);
  assert.match(h.html({ id: 'o4', kind: 'coupon' }, 'x', null, null), /A coupon: nothing is credited/);
  assert.equal(h.phrase({ kind: 'cashback', receiveAccountId: 'sav1' }), ' → Slice · Slice Savings');
  assert.equal(h.phrase({ kind: 'cashback', receiveAccountId: null }), ' → the paying account');
  assert.equal(h.phrase({ kind: 'points', programName: 'Slice Monies' }), ' → Slice Monies');
  assert.equal(h.phrase({ kind: 'discount' }), '');
});

test('the three places use it: Waiting for review, the map panel and the mapped rewards on a payment', () => {
  assert.match(ui, /ofPendOfferLabel\(m, choose\) \+ ofTargetHtml\(m, 'data-of-recv', m\.receiveAccountId, accountId\)/);
  assert.match(ui, /ofTargetHtml\(m, 'data-tx-map-recv', m\.receiveAccountId, x\.account_id\)/);
  assert.match(ui, /e\.kind === 'points' \? '<span class="of-recv">Goes to <b>'/);
  assert.match(ui, /from ' \+ esc\(a\.title\) \+ ofTargetPhrase\(a\)/);
});

test('server: a matched points offer carries its program\'s linked account; an earning carries the program name and account', async () => {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const mk = async (subtype, institution, name, balance) => { const id = (await createAccount(u.id, { subtype, institution, name }, { db: a })).account.id; await recordBalance(u.id, { accountId: id, balance, asOf: '2026-11-10T10:00:00Z', status: 'verified' }, { db: a, now: Date.parse('2026-11-14T10:00:00Z') }); return id; };
  const card = await mk('credit_card', 'HDFC Bank', 'Swiggy Card', 2000), sav = await mk('savings', 'Slice', 'Slice Savings', 10000);
  const prog = (await upsertRewardProgram(u.id, { programKey: 'monies', provider: 'Slice', name: 'Slice Monies', unit: 'Monies', inrPerUnit: 0.01, rateSource: 'rules', accountId: sav }, { db: a })).programId;
  await saveOffer(u.id, { accountId: card, title: '1% as Monies', benefitType: 'percent', benefitValue: 1, rewardUnit: 'monies', programId: prog }, { db: a });
  const pay = (await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Food','Zepto',1000,'',$2,'2026-11-13') RETURNING id`, [u.id, card]))[0].id;
  const { offers, uses, programs } = await activeOffersFor(u.id, [card], { db: a });
  const m = matchOffers(offers, { account_id: card, kind: 'expense', category: 'Food', description: 'Zepto', amount: 1000, occurred_on: '2026-11-13', subtype_code: 'credit_card' }, uses, programs)[0];
  assert.deepEqual([m.kind, m.programName, m.programAccountId], ['points', 'Slice Monies', sav]);
  await acceptTransaction(uid(u), { transactionId: pay }, { db: a, now: Date.parse('2026-11-14T10:00:00Z') });
  const e = (await earningsForTransactions(u.id, [pay], { db: a })).get(pay)[0];
  assert.deepEqual([e.kind, e.program_name, e.program_account_id, e.units], ['points', 'Slice Monies', sav, 1000]);
});
const uid = u => u.id;
