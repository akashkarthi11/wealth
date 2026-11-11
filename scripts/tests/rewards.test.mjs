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

test('Rewards page: points card with progress and ₹ value, cash card with totals, unpriced card, update form', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Rewards page (2026-11-11'), src.indexOf('// Activity page (2026-11-11)'));
  const ctx = { esc: s => String(s ?? ''), money: v => '₹' + Number(v).toFixed(2), $: () => null, api: async () => ({}), Number, String, Date, Math, Object, JSON, Array, FormData: class {} };
  vm.runInNewContext(block + ';globalThis.t={rewardsPageHtml,setOpen:id=>{rewardsOpen=id}};', ctx);
  const d = { month: '2026-11', totals: { value: 1428.14, valuedPrograms: 2, unvaluedPrograms: 4 }, cashback: { month: 450, year: 3692.85, all_time: 3698.55, count: 46, categories: [{ category: 'Cashback', n: 19, amount: 732.7, last: '2026-11-06' }] },
    programs: [
      { id: 'g', provider: 'Paytm', name: 'Paytm Gold Coins', unit: 'Gold Coins', units: 436, value: 4.36, min_redeem: 500, toRedeem: 64, as_of: '2026-11-09T06:30:00Z', balance_status: 'verified', redeem_note: 'Convert at 500' },
      { id: 's', provider: 'Slice', name: 'Slice Spark cashback', unit: '₹ cashback', units: null, value: null, cashEarned: { month: 450, year: 450, all_time: 450, count: 3, last: '2026-11-07' } },
      { id: 'r', provider: 'Roarbank', name: 'Roarbank rewards', unit: 'points', units: null, value: null } ] };
  let html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /Rewards &amp; points/);
  assert.match(html, /<strong>₹1428\.14<\/strong><small>points value · 2 of 6 programs priced/);
  assert.match(html, /<b>436<\/b><span>Gold Coins<\/span><\/div><div class="rw-value">≈ ₹4\.36/);
  assert.match(html, /64 more to redeem \(500\)/);
  assert.match(html, /<small>This month<\/small><b>₹450\.00<\/b>/);
  assert.match(html, /3 credits · last .* · from your transactions/);
  assert.match(html, /<em>₹ value not set<\/em>/);
  assert.match(html, /No balance recorded yet/);
  assert.doesNotMatch(html, /data-reward-update="s"/, 'cash programs have no points to update');
  assert.match(html, /Cashback by type/);
  d.programs.push({ id: 'm', provider: 'Slice', name: 'Slice Monies', unit: 'Monies', units: 142378, value: 1423.78,
    schemeInfo: { rate: 0.01, spendBank: 'Slice', unitsPerRupee: 1, next: { at: 500000, rate: 0.02, label: 'Locked rate 2%' }, progressPct: 28.48, toNext: 357622, toNextSpend: 357622, monthSpend: 2000, monthUnitsEst: 2000, avgMonthlySpend: 30000, monthsToNext: 12 } });
  html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /<b>Earn 1% of Slice spends<\/b><small>≈ 1 Monies per ₹1 · 2% at 5,00,000<\/small>/);
  assert.match(html, /Locked rate 2%: 3,57,622 Monies to go \(28\.5%\) ≈ ₹357622\.00 of spends · about 12 months at your pace/);
  assert.match(html, /<small>Est\. Monies earned<\/small><b>2,000<\/b>/);
  ctx.t.setOpen('g'); html = ctx.t.rewardsPageHtml(d);
  assert.match(html, /<form class="rw-form" data-reward-form="g">/);
});
