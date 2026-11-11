// Account splits (0019, 2026-11-11): Atom → Invest later, Rent, Emergency fund, Round ups. Seed from the screenshot,
// signed movements (+ in / − out), estimated balance, rent reduces the Rent split, safety checks, and the page section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migratedDb } from './helpers/pglite.mjs';
import { splitsForAccount, recordSplitBalance, recordSplitMove } from '../../api/_splits.js';

const NOW = Date.parse('2026-11-12T06:00:00Z');
const SEED = readFileSync(new URL('../db/repairs/2026-11-11-atom-splits.sql', import.meta.url), 'utf8');

async function setup() {
  const { db, a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const acc = (key, bank, name) => a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,current_balance)
    VALUES($1,$2,$3,$4,'savings','savings','INR',63448.36) RETURNING id`, [u.id, key, bank, name]).then(r => r[0].id);
  const atom = await acc('atom-savings', 'Atom', 'Atom Savings'), slice = await acc('slice-savings', 'Slice', 'Slice Savings');
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES
    ($1,'transfer','Savings transfer','November round-ups',141,'',$2,'2026-11-07'),($1,'transfer','Savings transfer','November round-ups',18,'',$2,'2026-11-11')`, [u.id, atom]);
  await db.exec(SEED);
  return { db, a, uid: u.id, atom, slice };
}

test('seed: four splits with the screenshot balances; round-ups recorded as history (no change to the balance); idempotent', async () => {
  const { db, a, uid, atom } = await setup();
  await db.exec(SEED);
  const s = await splitsForAccount(uid, atom, { db: a });
  assert.equal(JSON.stringify(s.map(x => [x.name, x.balance, x.status])), JSON.stringify([['Invest later', 30036, 'verified'], ['Rent', 8209, 'verified'], ['Emergency fund', 25030, 'verified'], ['Round ups', 172, 'verified']]));
  assert.equal(s.find(x => x.key === 'round-ups').recentMoves.length, 2, 'both round-ups linked as history');
  const [n] = await a.query(`SELECT (SELECT count(*) FROM wealth_account_splits)::int s, (SELECT count(*) FROM wealth_account_split_balances)::int b, (SELECT count(*) FROM wealth_account_split_moves)::int m`);
  assert.deepEqual({ ...n }, { s: 4, b: 4, m: 2 });
});

test('paying rent reduces the Rent split; a round-up adds to Round ups; balances become estimated until the next screenshot', async () => {
  const { a, uid, atom } = await setup();
  const ids = Object.fromEntries((await splitsForAccount(uid, atom, { db: a })).map(x => [x.key, x.id]));
  const [rent] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','Rent','House rent',8000,'',$2,'2026-11-12') RETURNING id`, [uid, atom]);
  await recordSplitMove(uid, { splitId: ids.rent, amount: -8000, occurredAt: '2026-11-12T05:00:00Z', transactionId: rent.id, note: 'Rent paid' }, { db: a, now: NOW });
  await recordSplitMove(uid, { splitId: ids['round-ups'], amount: 12, occurredAt: '2026-11-12T05:30:00Z', note: 'Round-up' }, { db: a, now: NOW });
  const s = Object.fromEntries((await splitsForAccount(uid, atom, { db: a })).map(x => [x.key, x]));
  assert.deepEqual([s.rent.balance, s.rent.status, s.rent.movedSince], [209, 'estimated', -8000]);
  assert.deepEqual([s['round-ups'].balance, s['round-ups'].status], [184, 'estimated']);
  // the same transaction cannot be applied twice
  const again = await recordSplitMove(uid, { splitId: ids.rent, amount: -8000, occurredAt: '2026-11-12T05:00:00Z', transactionId: rent.id }, { db: a, now: NOW });
  assert.equal(again.duplicate, true);
  // a new screenshot resets to verified
  await recordSplitBalance(uid, { splitId: ids.rent, balance: 209, asOf: '2026-11-12T05:45:00Z' }, { db: a, now: NOW });
  const r = (await splitsForAccount(uid, atom, { db: a })).find(x => x.key === 'rent');
  assert.deepEqual([r.balance, r.status], [209, 'verified']);
});

test('interest after the screenshot is shared across the splits by balance, adds up exactly, and earlier interest is ignored', async () => {
  const { a, uid, atom } = await setup();
  const accrue = (d, amt) => a.query(`INSERT INTO wealth_interest_ledger(user_id,provider,product_key,account_key,partition_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,revision,calculation_status,notes,source_url)
    VALUES($1,'Slice','atom-savings','atom-savings','main',$2,63448,0.055,365,$3,'accrual',1,'estimated','t','https://example.test/rate')`, [uid, d, amt]);
  await accrue('2026-11-10', 9.56);                 // already inside the 11 Nov 5:21 PM screenshot ("earned yesterday")
  await accrue('2026-11-11', 9.5605); await accrue('2026-11-12', 9.5619);
  const s = await splitsForAccount(uid, atom, { db: a });
  const total = Math.round(s.reduce((n, x) => n + x.interestSince, 0) * 100) / 100;
  assert.equal(total, 19.12, 'exactly the two days after the screenshot (9.56 + 9.56 in paise)');
  const inv = s.find(x => x.key === 'invest-later'), ru = s.find(x => x.key === 'round-ups');
  assert.ok(Math.abs(inv.interestSince - 19.12 * 30036 / 63447) <= 0.02, 'Invest later gets ~47%');
  assert.ok(ru.interestSince <= 0.06, 'Round ups (₹172) gets a few paise');
  assert.equal(inv.status, 'estimated');
  assert.equal(inv.balance, Math.round((30036 + inv.interestSince) * 100) / 100);
});

test('safety: a transaction on another account cannot move a split; zero / future / unknown are refused', async () => {
  const { a, uid, atom, slice } = await setup();
  const id = (await splitsForAccount(uid, atom, { db: a }))[0].id;
  const [t] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,'expense','x','x',5,'',$2,'2026-11-11') RETURNING id`, [uid, slice]);
  await assert.rejects(recordSplitMove(uid, { splitId: id, amount: -5, transactionId: t.id }, { db: a, now: NOW }), /another account/);
  await assert.rejects(recordSplitMove(uid, { splitId: id, amount: 0 }, { db: a, now: NOW }), /non-zero/);
  await assert.rejects(recordSplitMove(uid, { splitId: id, amount: 5, occurredAt: '2027-01-01T00:00:00Z' }, { db: a, now: NOW }), /not in the future/);
  await assert.rejects(recordSplitBalance(uid, { splitId: '00000000-0000-4000-8000-000000000000', balance: 1 }, { db: a, now: NOW }), /Split not found/);
});

test('account page shows the splits, shares, recent moves and the add-up check', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Splits inside an account (0019)'), src.indexOf('function accountDetailHtml(d){'));
  const ctx = { esc: s => String(s ?? ''), money: v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }), Number, String, Date, Math, JSON, Array };
  vm.runInNewContext(block + ';globalThis.t={splitsHtml};', ctx);
  const d = { account: { current_balance: 63448.36 }, splits: [
    { name: 'Invest later', kind: 'goal', balance: 30036, status: 'verified', verifiedAt: '2026-11-11T11:51:00Z', recentMoves: [] },
    { name: 'Rent', kind: 'goal', balance: 209, status: 'estimated', movedSince: -8000, verifiedAt: '2026-11-11T11:51:00Z', recentMoves: [{ at: '2026-11-12T05:00:00Z', amount: -8000, note: 'Rent paid' }] },
    { name: 'Round ups', kind: 'roundups', balance: 172, status: 'verified', verifiedAt: '2026-11-11T11:51:00Z', recentMoves: [] } ] };
  const html = ctx.t.splitsHtml(d);
  assert.match(html, /<h4>Splits<\/h4>/);
  assert.match(html, /<b>Rent<\/b><small>Goal not set · estimated \(−₹8,000 since 11 Nov\)<\/small>/);
  assert.match(html, /−₹8,000 12 Nov · Rent paid/);
  assert.match(html, /<b>Round ups<\/b><small>Round-ups · verified 11 Nov/);
  assert.match(html, /Splits total ₹30,417 vs account ₹63,448\.36 — ₹33,031\.36 not in any split/);
  assert.equal(ctx.t.splitsHtml({ account: {}, splits: [] }), '');
});
