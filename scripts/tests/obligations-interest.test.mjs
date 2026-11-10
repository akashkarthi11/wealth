import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, applyMigrations } from '../db/migrations-lib.mjs';
import { freshDb, MIGRATIONS_DIR } from './helpers/pglite.mjs';
import { setBillStatus } from '../../api/_queries.js';

const quiet = { log: () => {} };
const all = loadMigrations(MIGRATIONS_DIR);

// Legacy-shaped rows written before 0005, then 0005 applied on top.
async function legacy() {
  const { a } = await freshDb();
  await applyMigrations(a, all.filter(m => m.id < '0005'), quiet);
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash) VALUES('o@example.test','x') RETURNING id`);
  const uid = u.id;
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name) VALUES($1,'slice-savings-1','Slice','Savings') RETURNING id`, [uid]);
  const [ob] = await a.query(`INSERT INTO wealth_recurring_obligations(user_id,obligation_key,title,expected_amount,frequency,source_type)
    VALUES($1,'bill:rent','Rent',8500,'monthly','planned_bill') RETURNING id`, [uid]);
  const [bill] = await a.query(`INSERT INTO wealth_planned_bills(user_id,title,amount,due_date,bill_key,recurrence) VALUES($1,'Rent',8500,'2026-11-09','rent','monthly') RETURNING id`, [uid]);
  await a.query(`INSERT INTO wealth_payment_occurrences(user_id,obligation_id,due_date,expected_amount,source_record_id) VALUES($1,$2,'2026-11-09',8500,$3)`, [uid, ob.id, bill.id]);
  await a.query(`INSERT INTO wealth_interest_rates(provider,product_key,annual_rate,effective_from,source_url) VALUES('Slice Small Finance Bank','slice-savings',0.055,'2026-10-06','test://rate')`);
  await a.query(`INSERT INTO wealth_interest_ledger(user_id,provider,product_key,account_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,source_url)
    VALUES($1,'Slice Small Finance Bank','slice-savings','slice-savings-1','2026-11-08',47875,0.055,365,7.21,'accrual','test://ledger')`, [uid]);
  await a.query(`INSERT INTO wealth_interest_statements(user_id,provider,product_key,period_start,period_end,statement_total,statement_label) VALUES($1,'Slice','slice-savings','2026-10-31','2026-11-08',64.36,'Oct-Nov')`, [uid]);
  await applyMigrations(a, all, quiet);
  return { a, uid, accId: acc.id, obId: ob.id, billId: bill.id };
}

test('0005 links bills to obligations and occurrences to bills with real keys (TR-6.1)', async () => {
  const { a, obId, billId } = await legacy();
  assert.equal((await a.query('SELECT obligation_id FROM wealth_planned_bills WHERE id=$1', [billId]))[0].obligation_id, obId);
  assert.equal((await a.query('SELECT planned_bill_id FROM wealth_payment_occurrences'))[0].planned_bill_id, billId);
});

test('interest rows point at one product per product_key despite different provider spellings (TR-6.3)', async () => {
  const { a, accId } = await legacy();
  const products = await a.query('SELECT product_key, provider FROM wealth_interest_products');
  assert.deepEqual(products.map(p => p.product_key), ['slice-savings']);
  const ids = new Set((await a.query(`SELECT product_id FROM wealth_interest_rates UNION ALL SELECT product_id FROM wealth_interest_ledger UNION ALL SELECT product_id FROM wealth_interest_statements`)).map(r => r.product_id));
  assert.equal(ids.size, 1);
  assert.equal((await a.query('SELECT account_id FROM wealth_interest_ledger'))[0].account_id, accId);
});

test('rows written later by external jobs (text keys only) are linked by triggers', async () => {
  const { a, uid, accId } = await legacy();
  await a.query(`INSERT INTO wealth_interest_ledger(user_id,provider,product_key,account_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,source_url)
    VALUES($1,'Slice','slice-savings','slice-savings-1','2026-11-09',47882,0.055,365,7.22,'accrual','test://ledger')`, [uid]);
  await a.query(`INSERT INTO wealth_interest_rates(provider,product_key,annual_rate,effective_from,source_url) VALUES('Angel One','angel-one-fd',0.08,'2026-11-10','test://rate')`);
  const [row] = await a.query(`SELECT l.account_id, p.product_key FROM wealth_interest_ledger l JOIN wealth_interest_products p ON p.id=l.product_id WHERE l.accrual_date='2026-11-09'`);
  assert.equal(row.account_id, accId);
  assert.equal(row.product_key, 'slice-savings');
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_interest_products WHERE product_key='angel-one-fd'`))[0].n, 1, 'new products are registered automatically');
  const [ob] = await a.query(`INSERT INTO wealth_recurring_obligations(user_id,obligation_key,title,source_type) VALUES($1,'bill:netflix','Netflix','planned_bill') RETURNING id`, [uid]);
  const [bill] = await a.query(`INSERT INTO wealth_planned_bills(user_id,title,amount,due_date,bill_key) VALUES($1,'Netflix',199,'2026-11-12','netflix') RETURNING obligation_id`, [uid]);
  assert.equal(bill.obligation_id, ob.id);
});

test('marking a bill paid updates its payment occurrence in the same statement (TR-6.2)', async () => {
  const { a, uid, billId } = await legacy();
  const r = await setBillStatus(uid, billId, 'paid', a);
  assert.deepEqual({ ...r, id: undefined }, { id: undefined, status: 'paid', occurrences_updated: 1 });
  const [occ] = await a.query('SELECT status, actual_amount::float8 AS amt, paid_at FROM wealth_payment_occurrences');
  assert.equal(occ.status, 'paid');
  assert.equal(occ.amt, 8500);
  assert.ok(occ.paid_at);
  await setBillStatus(uid, billId, 'planned', a);
  const [back] = await a.query('SELECT status, actual_amount, paid_at FROM wealth_payment_occurrences');
  assert.deepEqual({ ...back }, { status: 'planned', actual_amount: null, paid_at: null });
});

test("another user's bill cannot be changed", async () => {
  const { a, billId } = await legacy();
  const [other] = await a.query(`INSERT INTO wealth_users(email,password_hash) VALUES('x@example.test','x') RETURNING id`);
  assert.equal(await setBillStatus(other.id, billId, 'paid', a), null);
});
