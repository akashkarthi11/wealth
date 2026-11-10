import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';

async function twoUsers() {
  const { a } = await migratedDb();
  const [u1] = await a.query(`INSERT INTO wealth_users(email,password_hash) VALUES('one@example.test','x') RETURNING id`);
  const [u2] = await a.query(`INSERT INTO wealth_users(email,password_hash) VALUES('two@example.test','x') RETURNING id`);
  return { a, u1: u1.id, u2: u2.id };
}
const position = (a, uid, extra = {}) => a.query(
  `INSERT INTO wealth_positions(user_id,category,platform_name,record_type,name,ticker,currency,quantity,current_value)
   VALUES($1,'INVESTMENT',$2,$3,$4,$5,'INR',1,100) RETURNING id`,
  [uid, extra.platform ?? 'Angel One', extra.type ?? 'EQUITY', extra.name ?? 'LT', extra.ticker ?? 'LT']).then(r => r[0].id);
const rejects = async (p, code) => { await assert.rejects(p, e => e.code === code || new RegExp(code).test(String(e.message))); };

test('a child row cannot belong to a different user than its parent (TR-4.1)', async () => {
  const { a, u1, u2 } = await twoUsers();
  const p1 = await position(a, u1);
  await rejects(a.query(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,display_name,quantity_unit,price_currency)
    VALUES($1,$2,'indian_equity','LT','share','INR')`, [u2, p1]), '23503');
  // Same user is fine.
  await a.query(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,display_name,quantity_unit,price_currency)
    VALUES($1,$2,'indian_equity','LT','share','INR')`, [u1, p1]);
});

test('one active position per holding; archived copies are allowed (TR-4.2)', async () => {
  const { a, u1, u2 } = await twoUsers();
  await position(a, u1);
  await rejects(position(a, u1, { name: 'lt' }), '23505');            // same ticker, same platform
  await position(a, u1, { platform: 'Zerodha' });                     // other platform: separate holding
  await position(a, u2);                                              // other user: separate holding
  await position(a, u1, { type: 'EQUITY_AGGREGATE_ARCHIVED' });       // archived rows exempt
  await position(a, u1, { type: 'EQUITY_AGGREGATE_ARCHIVED' });
});

test('deleting a parent clears only the reference, never user_id', async () => {
  const { a, u1 } = await twoUsers();
  const [snap] = await a.query(`INSERT INTO wealth_snapshots(user_id,source_key,source_name,snapshot_date,payload) VALUES($1,'s1','S',CURRENT_DATE,'{}') RETURNING id`, [u1]);
  const [p] = await a.query(`INSERT INTO wealth_positions(user_id,category,record_type,name,currency,current_value,source_snapshot_id)
    VALUES($1,'INVESTMENT','EPF','EPF','INR',10,$2) RETURNING id`, [u1, snap.id]);
  await a.query('DELETE FROM wealth_snapshots WHERE id=$1', [snap.id]);
  const [row] = await a.query('SELECT user_id, source_snapshot_id FROM wealth_positions WHERE id=$1', [p.id]);
  assert.equal(row.user_id, u1);
  assert.equal(row.source_snapshot_id, null);
});

test('transaction external references are unique per user (TR-4.2)', async () => {
  const { a, u1, u2 } = await twoUsers();
  const tx = (uid, ref) => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,amount,occurred_on,external_ref) VALUES($1,'expense','Food',10,CURRENT_DATE,$2)`, [uid, ref]);
  await tx(u1, 'stmt-1');
  await rejects(tx(u1, 'stmt-1'), '23505');
  await tx(u2, 'stmt-1');
  await tx(u1, null); await tx(u1, null);   // genuine identical purchases without a reference stay allowed
});

test('one advisor report per run time', async () => {
  const { a, u1 } = await twoUsers();
  const r = () => a.query(`INSERT INTO wealth_stock_advisor_reports(user_id,run_at) VALUES($1,'2026-11-10T09:00:00Z')`, [u1]);
  await r();
  await rejects(r(), '23505');
});

test('no duplicate indexes remain (TR-4.3)', async () => {
  const { a } = await migratedDb();
  const dupes = await a.query(`SELECT a.indexrelid::regclass::text AS idx FROM pg_index a JOIN pg_index b
    ON a.indrelid=b.indrelid AND a.indexrelid<>b.indexrelid AND a.indkey::text=b.indkey::text
   AND coalesce(a.indpred::text,'')=coalesce(b.indpred::text,'') AND coalesce(a.indexprs::text,'')=coalesce(b.indexprs::text,'')
   JOIN pg_class c ON c.oid=a.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`);
  assert.deepEqual(dupes.map(d => d.idx), []);
});
