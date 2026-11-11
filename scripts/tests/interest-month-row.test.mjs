// Owner rule (2026-11-11): interest is never taken from screenshots; the nightly task keeps ONE "interest this month"
// income transaction per daily-credited account at the app's figure (statement to its end date + accruals after it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { upsertMonthInterestRow } from '../../api/_interest.js';

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency)
    VALUES($1,'slice-savings-3731','Slice','Slice Savings','savings','savings','INR') RETURNING id`, [u.id]);
  const l = { account_id: acc.id, account_key: 'slice-savings-3731', product_key: 'slice-savings', bank_name: 'Slice', account_name: 'Slice Savings', provider: 'Slice' };
  const accrue = (d, amt, entry = 'accrual', rev = 1) => a.query(`INSERT INTO wealth_interest_ledger(user_id,provider,product_key,account_key,partition_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,revision,calculation_status,notes,source_url)
    VALUES($1,'Slice','slice-savings','slice-savings-3731','main',$2,47882,0.055,365,$3,$4,$5,'estimated','t','https://example.test/rate')`, [u.id, d, amt, entry, rev]);
  return { a, uid: u.id, l, accrue };
}
const rows = async (a, uid) => (await a.query(`SELECT amount::float8 AS amount, occurred_on::text AS d, external_ref, kind, category FROM wealth_transactions WHERE user_id=$1 ORDER BY occurred_on`, [uid]));

test('statement 1–9 Nov + accruals after it = one month row; updated in place; idempotent', async () => {
  const { a, uid, l, accrue } = await setup();
  await a.query(`INSERT INTO wealth_interest_statements(user_id,provider,product_key,period_start,period_end,statement_total,statement_label) VALUES($1,'Slice','slice-savings','2026-11-01','2026-11-09',64.36,'Nov savings interest')`, [uid]);
  await accrue('2026-11-08', 7.2); await accrue('2026-11-09', 7.21);     // inside the statement → not added again
  await accrue('2026-11-10', 7.2151);
  let r = await upsertMonthInterestRow(a, uid, l, '2026-11-10');
  assert.deepEqual([r.amount, r.through, r.written], [71.58, '2026-11-10', true]);
  assert.equal(JSON.stringify(await rows(a, uid)), JSON.stringify([{ amount: 71.58, d: '2026-11-10', external_ref: 'interest-month:slice-savings:2026-11', kind: 'income', category: 'Interest' }]));
  r = await upsertMonthInterestRow(a, uid, l, '2026-11-10');
  assert.equal(r.written, false, 'same figure → no write');
  await accrue('2026-11-11', 7.21);
  r = await upsertMonthInterestRow(a, uid, l, '2026-11-11');
  assert.deepEqual([r.amount, r.written], [78.79, true]);
  const all = await rows(a, uid);
  assert.equal(all.length, 1, 'still one row for the month');
  assert.deepEqual([all[0].amount, all[0].d], [78.79, '2026-11-11']);
});

test('without a statement the month row is the accruals; corrections (signed) are included; a new month gets a new row', async () => {
  const { a, uid, l, accrue } = await setup();
  await accrue('2026-12-01', 7.3); await accrue('2026-12-02', 7.3); await accrue('2026-12-02', -0.05, 'correction', 2);
  const r = await upsertMonthInterestRow(a, uid, l, '2026-12-02');
  assert.deepEqual([r.month, r.amount], ['2026-12', 14.55]);
  const [row] = await a.query(`SELECT external_ref, description FROM wealth_transactions WHERE user_id=$1`, [uid]);
  assert.equal(row.external_ref, 'interest-month:slice-savings:2026-12');
  assert.match(row.description, /^Slice Savings interest · Dec 2026 to date \(app: nightly accrual\)$/);
  const none = await upsertMonthInterestRow(a, uid, l, '2027-01-01');
  assert.deepEqual([none.amount, none.written], [0, false], 'no interest yet → no row');
});
