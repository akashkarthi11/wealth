// Plan 4 Part 0 (2026-11-11): external writers (no wealth.actor) cannot set pending_reconciliation or move a balance
// back in time; the app / owner / agents are unaffected; data quality flags a dashboard ↔ balance-history mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { collectIssues } from '../../api/_dataquality.js';

const NOW = Date.parse('2026-11-11T09:00:00Z');

async function setup() {
  const { db, a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,current_balance,balance_as_of,balance_status)
    VALUES($1,'slice-savings-3731','Slice','Slice Savings','savings','savings','INR',47889.22,'2026-11-10T18:29:59Z','stale') RETURNING id`, [u.id]);
  return { db, a, uid: u.id, id: acc.id };
}
// Run statements in one transaction, optionally as a named actor (like withActor in the app).
const as = (db, actor, stmts) => db.transaction(async tx => {
  if (actor) await tx.query(`SELECT set_config('wealth.actor', $1, true)`, [actor]);
  for (const [t, p] of stmts) await tx.query(t, p || []);
});

test('external writer cannot set pending_reconciliation on an account or a balance row', async () => {
  const { db, id } = await setup();
  await assert.rejects(as(db, null, [[`UPDATE wealth_accounts SET current_balance=42889.22, balance_as_of='2026-11-11T07:31:00Z', balance_status='pending_reconciliation' WHERE id=$1`, [id]]]),
    /pending_reconciliation is not allowed/);
  await assert.rejects(as(db, null, [[`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-11T08:00:00Z',1,'pending_reconciliation')`, [id]]]),
    /pending_reconciliation is not allowed/);
  const [row] = (await db.query(`SELECT current_balance::float8 AS b, balance_status FROM wealth_accounts WHERE id=$1`, [id])).rows;
  assert.deepEqual({ ...row }, { b: 47889.22, balance_status: 'stale' }, 'nothing changed');
});

test('external writer cannot move a balance back in time, but can record a newer stale or verified balance', async () => {
  const { db, id } = await setup();
  await as(db, null, [[`UPDATE wealth_accounts SET current_balance=42889.22, balance_as_of='2026-11-11T07:31:00Z', balance_status='stale' WHERE id=$1`, [id]]]);
  await assert.rejects(as(db, null, [[`UPDATE wealth_accounts SET current_balance=47889.22, balance_as_of='2026-11-10T18:29:59Z' WHERE id=$1`, [id]]]),
    /cannot move back in time/);
  await as(db, null, [[`UPDATE wealth_accounts SET current_balance=42800, balance_as_of='2026-11-11T12:00:00Z', balance_status='verified' WHERE id=$1`, [id]]]);
  const [row] = (await db.query(`SELECT current_balance::float8 AS b FROM wealth_accounts WHERE id=$1`, [id])).rows;
  assert.equal(row.b, 42800);
});

test('the app, owner and agents (actor set) are not restricted', async () => {
  const { db, id } = await setup();
  for (const actor of ['owner', 'agent', 'cron']) {
    await as(db, actor, [[`UPDATE wealth_accounts SET balance_status='pending_reconciliation' WHERE id=$1`, [id]],
      [`UPDATE wealth_accounts SET balance_as_of='2026-11-09T00:00:00Z', balance_status='stale' WHERE id=$1`, [id]]]);
  }
  await as(db, 'owner', [[`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-11T08:00:00Z',1,'pending_reconciliation')`, [id]]]);
});

test('data quality flags a dashboard ↔ balance-history mismatch (the Slice case) and clears when they agree', async () => {
  const { db, a, uid, id } = await setup();
  await as(db, 'owner', [[`INSERT INTO wealth_account_balances(account_id,as_of,balance,status,note) VALUES($1,'2026-11-11T07:31:00Z',42889.22,'estimated','after ₹5,000')`, [id]]]);
  let issues = (await collectIssues(uid, { db: a, now: NOW, env: {} })).issues.filter(i => i.category === 'balance_mismatch');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Slice · Slice Savings: dashboard shows ₹47,889\.22 \(2026-11-10\) but the newest balance is ₹42,889\.22 \(2026-11-11, estimated\)/);
  assert.equal(issues[0].severity, 'high');
  await as(db, 'owner', [[`UPDATE wealth_accounts SET current_balance=42889.22, balance_as_of='2026-11-11T07:31:00Z' WHERE id=$1`, [id]]]);
  issues = (await collectIssues(uid, { db: a, now: NOW, env: {} })).issues.filter(i => i.category === 'balance_mismatch');
  assert.equal(issues.length, 0);
});
