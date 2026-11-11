// Plan 4 Part A (2026-11-11): reward programs, balances, cash rewards summed from transactions (never copied),
// validation, the seed repair (idempotent), and the Rewards page markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migratedDb } from './helpers/pglite.mjs';
import { rewardsOverview, recordRewardBalance, recordRewardEvent, upsertRewardProgram, rewardValue } from '../../api/_rewards.js';

const NOW = Date.parse('2026-11-11T09:00:00Z');
const SEED = readFileSync(new URL('../db/repairs/2026-11-11-seed-reward-programs.sql', import.meta.url), 'utf8');

async function setup() {
  const { db, a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const acc = (key, bank, name, type, mi) => a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,masked_identifier)
    VALUES($1,$2,$3,$4,$5,$5,'INR',$6) RETURNING id`, [u.id, key, bank, name, type, mi]).then(r => r[0].id);
  const sliceCc = await acc('slice-credit-card-6136', 'Slice', 'Slice Credit Card', 'credit_card', '••6136');
  const hdfcCc = await acc('hdfc-swiggy-9229', 'HDFC Bank', 'HDFC Swiggy Orange', 'credit_card', '••9229');
  const tx = (kind, category, description, amount, day, accountId = null) => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,$2,$3,$4,$5,'',$6,$7)`, [u.id, kind, category, description, amount, accountId, day]);
  await tx('income', 'Reward credit', 'Spark cashback', 300, '2026-11-07');
  await tx('income', 'Cashback', 'Spark cashback', 100, '2026-11-06');
  await tx('income', 'Cashback', '5% Swiggy Orange cashback', 36, '2026-10-22', hdfcCc);
  await tx('income', 'Credit card cashback', 'Nykaa', 589, '2026-07-12', sliceCc);
  await tx('expense', 'Food', 'Swiggy', 500, '2026-11-05', hdfcCc);
  await db.exec(SEED);
  return { db, a, uid: u.id };
}

test('seed: six programs, verified balances, ₹ value only where a rate with a source exists; re-run adds nothing', async () => {
  const { db, a, uid } = await setup();
  const o = await rewardsOverview(uid, { db: a, now: NOW });
  const by = Object.fromEntries(o.programs.map(p => [p.program_key, p]));
  assert.deepEqual(Object.keys(by).sort(), ['hdfc-swiggy-orange', 'paytm-gold-coins', 'roarbank-rewards', 'slice-card-cashback', 'slice-monies', 'slice-spark']);
  assert.deepEqual([by['paytm-gold-coins'].units, by['paytm-gold-coins'].value, by['paytm-gold-coins'].toRedeem], [436, 4.36, 64]);
  assert.deepEqual([by['slice-monies'].units, by['slice-monies'].value], [142378, 1423.78]);
  assert.equal(by['paytm-gold-coins'].history.length, 3);
  assert.equal(by['roarbank-rewards'].units, null);
  assert.equal(by['roarbank-rewards'].value, null);
  assert.deepEqual([o.totals.value, o.totals.valuedPrograms], [1428.14, 2]);
  await db.exec(SEED);
  const [n] = await a.query(`SELECT (SELECT count(*) FROM wealth_reward_programs)::int p, (SELECT count(*) FROM wealth_reward_balances)::int b`);
  assert.deepEqual({ ...n }, { p: 6, b: 6 });
});

test('cash rewards are summed from income transactions, scoped to the linked card, never copied', async () => {
  const { a, uid } = await setup();
  const o = await rewardsOverview(uid, { db: a, now: NOW });
  const by = Object.fromEntries(o.programs.map(p => [p.program_key, p]));
  assert.deepEqual([by['slice-spark'].cashEarned.month, by['slice-spark'].cashEarned.count], [400, 2]);
  assert.deepEqual([by['hdfc-swiggy-orange'].cashEarned.all_time, by['hdfc-swiggy-orange'].cashEarned.count], [36, 1], 'only cashback on the HDFC card, not the Swiggy expense');
  assert.equal(by['slice-card-cashback'].cashEarned.all_time, 589);
  assert.deepEqual([o.cashback.month, o.cashback.all_time, o.cashback.count], [400, 1025, 4]);
  const [t] = await a.query(`SELECT count(*)::int n FROM wealth_transactions`);
  assert.equal(t.n, 5, 'no transaction was added');
});

test('record a balance (newest wins), validation, events and program rate need a source', async () => {
  const { a, uid } = await setup();
  const [p] = await a.query(`SELECT id FROM wealth_reward_programs WHERE program_key='paytm-gold-coins'`);
  const r = await recordRewardBalance(uid, { programId: p.id, units: 502, asOf: '2026-11-11T08:00:00Z' }, { db: a, now: NOW });
  assert.deepEqual([r.stored, r.value], [true, 5.02]);
  const o = await rewardsOverview(uid, { db: a, now: NOW });
  const g = o.programs.find(x => x.program_key === 'paytm-gold-coins');
  assert.deepEqual([g.units, g.toRedeem], [502, 0]);
  await assert.rejects(recordRewardBalance(uid, { programId: p.id, units: -1 }, { db: a, now: NOW }), /units must be a number ≥ 0/);
  await assert.rejects(recordRewardBalance(uid, { programId: p.id, units: 1, asOf: '2027-01-01T00:00:00Z' }, { db: a, now: NOW }), /not in the future/);
  await assert.rejects(recordRewardBalance(uid, { programId: p.id, units: 1, status: 'pending_reconciliation' }, { db: a, now: NOW }), /status must be verified/);
  await assert.rejects(recordRewardBalance(uid, { programId: '00000000-0000-4000-8000-000000000000', units: 1 }, { db: a, now: NOW }), /Program not found/);
  const ev = await recordRewardEvent(uid, { programId: p.id, occurredOn: '2026-11-11', kind: 'redeemed', units: -500, inrValue: 5 }, { db: a });
  assert.equal(ev.stored, true);
  const [m] = await a.query(`SELECT id FROM wealth_reward_programs WHERE program_key='roarbank-rewards'`);
  await assert.rejects(upsertRewardProgram(uid, { programId: m.id, inrPerUnit: 0.25 }, { db: a }), /rateSource is required/);
  await upsertRewardProgram(uid, { programId: m.id, inrPerUnit: 0.25, rateSource: 'Roarbank redeem screen 11 Nov', rateAsOf: '2026-11-11' }, { db: a });
  const [rate] = await a.query(`SELECT inr_per_unit::float8 r FROM wealth_reward_programs WHERE id=$1`, [m.id]);
  assert.equal(rate.r, 0.25);
  assert.equal(rewardValue({ inr_per_unit: null }, 100), null);
});

test('Slice Monies scheme: % of Slice spends, progress to the 2% tier, estimate from this month (repair is idempotent)', async () => {
  const { db, a, uid } = await setup();
  const [cc] = await a.query(`SELECT id FROM wealth_accounts WHERE bank_name='Slice'`);
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES
    ($1,'expense','Food','Swiggy',1200,'',$2,'2026-11-05'),($1,'expense','Travel','Redbus',800,'',$2,'2026-11-08'),($1,'transfer','Card payment','Bill',5000,'',$2,'2026-11-09')`, [uid, cc.id]);
  const REPAIR = readFileSync(new URL('../db/repairs/2026-11-11-slice-monies-scheme.sql', import.meta.url), 'utf8');
  await db.exec(REPAIR); await db.exec(REPAIR);
  const o = await rewardsOverview(uid, { db: a, now: NOW });
  const m = o.programs.find(p => p.program_key === 'slice-monies');
  assert.equal(m.scheme.rate, 0.01);
  const si = m.schemeInfo;
  assert.deepEqual([si.unitsPerRupee, si.next.at, si.next.rate, si.toNext, si.toNextSpend], [1, 500000, 0.02, 357622, 357622]);
  assert.equal(si.progressPct, 28.48);
  assert.deepEqual([si.monthSpend, si.monthUnitsEst], [2000, 2000], 'expenses only — the card bill transfer is not a spend');
  const [a2] = await a.query(`SELECT count(*)::int n FROM wealth_audit_log WHERE table_name='wealth_reward_programs' AND action='update'`);
  assert.equal(a2.n, 1, 'second run changed nothing');
});

test('every program linked to an account; Spark keeps counting its account-less credits; link can be changed', async () => {
  const { db, a, uid } = await setup();
  const add = (key, bank, name, type, mi) => a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,masked_identifier,status)
    VALUES($1,$2,$3,$4,$5,$5,'INR',$6,'active') RETURNING id`, [uid, key, bank, name, type, mi]).then(r => r[0].id);
  const slice = await add('slice-savings-3731', 'Slice', 'Slice Savings', 'savings', '••3731');
  const gold = await add('paytm-gold', 'Paytm Gold', 'Digital gold', 'digital_gold', null);
  const roar = await add('roarbank-cc', 'Roarbank', 'Roarbank Credit Card', 'credit_card', null);
  const LINK = readFileSync(new URL('../db/repairs/2026-11-11-link-reward-accounts.sql', import.meta.url), 'utf8');
  await db.exec(LINK); await db.exec(LINK);
  const rows = await a.query(`SELECT program_key, account_id, cash_any_account FROM wealth_reward_programs ORDER BY program_key`);
  const by = Object.fromEntries(rows.map(r => [r.program_key, r]));
  assert.equal(rows.filter(r => !r.account_id).length, 0, 'all six linked');
  assert.deepEqual([by['paytm-gold-coins'].account_id, by['slice-monies'].account_id, by['slice-spark'].account_id, by['roarbank-rewards'].account_id], [gold, slice, slice, roar]);
  assert.equal(by['slice-spark'].cash_any_account, true);
  const o = await rewardsOverview(uid, { db: a, now: NOW });
  const spark = o.programs.find(p => p.program_key === 'slice-spark');
  assert.deepEqual([spark.cashEarned.month, spark.account_bank, spark.account_mask], [400, 'Slice', '••3731'], 'Spark credits without an account still count');
  const prog = o.programs.find(p => p.program_key === 'roarbank-rewards');
  await upsertRewardProgram(uid, { programId: prog.id, accountId: slice }, { db: a });
  const [after] = await a.query(`SELECT account_id FROM wealth_reward_programs WHERE id=$1`, [prog.id]);
  assert.equal(after.account_id, slice);
  await assert.rejects(upsertRewardProgram(uid, { programId: prog.id, accountId: '00000000-0000-4000-8000-000000000000' }, { db: a }), /Account not found/);
});

test('reward alerts (ready / near / expiring) and the dashboard tile', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Rewards page (2026-11-11'), src.indexOf('// Activity page (2026-11-11)'));
  const ctx = { esc: s => String(s ?? ''), money: v => '₹' + Number(v).toFixed(2), $: () => null, api: async () => ({}), Number, String, Date, Math, Object, JSON, Array, FormData: class {} };
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  vm.runInNewContext(block + ';globalThis.t={rewardAlertItems,rewardAlertsHtml,rewardsTileHtml,set:d=>{rewardsData=d}};', ctx);
  assert.equal(ctx.t.rewardsTileHtml(), '', 'no tile before data');
  ctx.t.set({ totals: { value: 1428.14 }, cashback: { month: 450 }, programs: [
    { id: 'a', name: 'Paytm Gold Coins', unit: 'Gold Coins', units: 436, min_redeem: 500, toRedeem: 64, value: 4.36 },      // 12.8 % away → no alert
    { id: 'b', name: 'Near', unit: 'points', units: 460, min_redeem: 500, toRedeem: 40, value: null },                     // 8 % away
    { id: 'c', name: 'Ready', unit: 'coins', units: 502, min_redeem: 500, toRedeem: 0, value: 5.02 },
    { id: 'd', name: 'Expiring', unit: 'points', units: 1200, expires_on: soon, value: null } ] });
  const kinds = ctx.t.rewardAlertItems().map(a => a.p.id + ':' + a.kind);
  assert.equal(JSON.stringify(kinds), JSON.stringify(['b:near', 'c:ready', 'd:expiring']));
  const html = ctx.t.rewardAlertsHtml();
  assert.match(html, /<h4>Rewards<\/h4>/);
  assert.match(html, /Ready to redeem — 502 coins ≈ ₹5\.02/);
  assert.match(html, /40 points more to redeem \(460 of 500\)/);
  assert.match(html, /1,200 points expire in 10 days/);
  assert.match(ctx.t.rewardsTileHtml(), /data-view="rewards"><small>REWARDS &amp; CASHBACK<\/small><strong>₹1428\.14<\/strong><span>points value · cashback this month ₹450\.00/);
  assert.match(src, /n=alertPaymentItems\(\)\.length\+rewardAlertItems\(\)\.length/, 'badge counts reward alerts');
  assert.match(src, /if\(d\.rewards\)rewardsData=d\.rewards;/, 'dashboard payload feeds rewards');
});

test('Rewards page: grouped by bank/app, account chips, compact cards, filters, scheme, update form with account select', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Rewards page (2026-11-11'), src.indexOf('// Activity page (2026-11-11)'));
  const ctx = { esc: s => String(s ?? ''), money: v => '₹' + Number(v).toFixed(2), $: () => null, api: async () => ({}), Number, String, Date, Math, Object, JSON, Array, Set, FormData: class {},
    accounts: [{ id: 'acc-slice', bank_name: 'Slice', account_name: 'Slice Savings', masked_identifier: '••3731' }, { id: 'acc-roar', bank_name: 'Roarbank', account_name: 'Roarbank Credit Card' }] };
  vm.runInNewContext(block + ';globalThis.t={rewardsPageHtml,rewardsForBankHtml,set:d=>{rewardsData=d},setOpen:id=>{rewardsOpen=id},setFilter:f=>{rewardsFilter=f}};', ctx);
  const d = { month: '2026-11', totals: { value: 1428.14, valuedPrograms: 2, unvaluedPrograms: 2 }, cashback: { month: 450, year: 3692.85, all_time: 3698.55, count: 46, categories: [{ category: 'Cashback', n: 19, amount: 732.7, last: '2026-11-06' }] },
    programs: [
      { id: 'g', provider: 'Paytm', name: 'Paytm Gold Coins', unit: 'Gold Coins', units: 436, value: 4.36, min_redeem: 500, toRedeem: 64, as_of: '2026-11-09T06:30:00Z', balance_status: 'verified', redeem_note: 'Convert at 500', account_id: 'acc-gold', account_bank: 'Paytm Gold', account_name: 'Digital gold', account_type: 'digital_gold' },
      { id: 's', provider: 'Slice', name: 'Slice Spark cashback', unit: '₹ cashback', units: null, value: null, account_id: 'acc-slice', account_bank: 'Slice', account_name: 'Slice Savings', account_mask: '••3731', account_type: 'savings', cashEarned: { month: 450, year: 450, all_time: 450, count: 3, last: '2026-11-07' } },
      { id: 'm', provider: 'Slice', name: 'Slice Monies', unit: 'Monies', units: 142378, value: 1423.78, account_id: 'acc-slice', account_bank: 'Slice', account_name: 'Slice Savings', account_mask: '••3731', account_type: 'savings',
        schemeInfo: { rate: 0.01, spendBank: 'Slice', unitsPerRupee: 1, next: { at: 500000, rate: 0.02, label: 'Locked rate 2%' }, progressPct: 28.48, toNext: 357622, toNextSpend: 357622, monthSpend: 2000, monthUnitsEst: 2000, avgMonthlySpend: 30000, monthsToNext: 12 } },
      { id: 'r', provider: 'Roarbank', name: 'Roarbank rewards', unit: 'points', units: null, value: null } ] };
  let html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /<strong>₹1428\.14<\/strong><small>points value · 2 of 4 priced/);
  assert.match(html, /4 programs · each linked to its account/);
  const order = [...html.matchAll(/<section class="rw-group"><div class="rw-g-head"><div><h4>([^<]+)<\/h4>/g)].map(m => m[1]);
  assert.equal(order.join(','), 'Slice,Paytm,Roarbank', 'largest group first');
  assert.match(html, /<h4>Slice<\/h4><small>Slice Savings ••3731<\/small>/);
  assert.match(html, /data-reward-account="Slice" data-reward-acct-type="savings" title="Open this account">Slice Savings ••3731/);
  assert.match(html, /<span class="rw-acct rw-acct-none">Not linked to an account<\/span>/);
  assert.match(html, /<div class="rw-fig"><b>436<\/b><span>Gold Coins<\/span><em class="">≈ ₹4\.36<\/em>/);
  assert.match(html, /64 more to redeem at 500/);
  assert.match(html, /<div class="rw-fig"><b>₹450\.00<\/b><span>this year<\/span><em>₹450\.00 this month · ₹450\.00 all time<\/em>/);
  assert.match(html, /No balance yet — tap <b>Add<\/b>/);
  assert.match(html, /data-reward-update="r" aria-expanded="false">Add</);
  assert.match(html, /<b>Earn 1% of Slice spends<\/b><small>≈ 1 Monies per ₹1 · 2% at 5,00,000<\/small>/);
  assert.match(html, /Locked rate 2%: 3,57,622 Monies to go \(28\.5%\) ≈ ₹357622\.00 of spends · about 12 months at your pace/);
  assert.match(html, /<details class="rw-cats"><summary>Cashback by type/);
  ctx.t.setFilter('cash'); html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /Slice Spark cashback/); assert.doesNotMatch(html, /Paytm Gold Coins/);
  assert.match(html, /data-reward-filter="cash" aria-pressed="true">Cashback <em>1<\/em>/);
  ctx.t.setFilter('all'); ctx.t.setOpen('m'); html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /<form class="rw-form" data-reward-form="m" data-reward-account-was="acc-slice">/);
  assert.match(html, /<option value="acc-slice" selected>Slice · Slice Savings ••3731<\/option>/);
  ctx.t.setOpen('s'); html = ctx.t.rewardsPageHtml(d);
  assert.doesNotMatch(html.slice(html.indexOf('data-reward-form="s"')), /name="units"/, 'cash programs: account only, no units field');
  ctx.t.set(d);
  const bank = ctx.t.rewardsForBankHtml('Slice');
  assert.match(bank, /<h4>Rewards<\/h4><p>Points and cashback linked to Slice<\/p>/);
  assert.match(bank, /<b>Slice Monies<\/b><small>Slice Savings ••3731<\/small><\/span><span class="acct-amt"><b>1,42,378 Monies<\/b><small>≈ ₹1423\.78/);
  assert.equal(ctx.t.rewardsForBankHtml('HDFC Bank'), '');
});
