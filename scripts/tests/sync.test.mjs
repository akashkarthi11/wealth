// Phase B (TSD Claude Plan 2): every legacy write is mirrored into the account model (v2),
// nothing is deleted, and a failing sync never blocks the legacy write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { accountHierarchyRows } from '../../api/_queries.js';
import { valuePortfolio } from '../../api/_valuation.js';

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  return { a, uid: u.id };
}
const position = (a, uid, f) => a.query(
  `INSERT INTO wealth_positions(user_id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,metadata)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
  [uid, f.category ?? 'INVESTMENT', f.institution ?? null, f.platform ?? 'Broker', f.type, f.name, f.ticker ?? null, f.currency ?? 'INR',
   f.quantity ?? null, f.value ?? 100, f.invested ?? null, f.asOf ?? '2026-11-10T09:00:00Z', JSON.stringify(f.metadata ?? {})]).then(r => r[0].id);
const asset = (a, uid, positionId, cls, symbol, unit = 'share', currency = 'INR') => a.query(
  `INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
   VALUES($1,$2,$3,$4,$4,$5,$6,'Yahoo Finance',$4,'active') RETURNING id`, [uid, positionId, cls, symbol, unit, currency]).then(r => r[0].id);
const holdingOf = async (a, symbol) => (await a.query(
  `SELECT h.quantity::float8 q, h.invested_value::float8 inv, h.status, h.closed_at, acc.account_key
   FROM wealth_holdings h JOIN wealth_instruments i ON i.id=h.instrument_id JOIN wealth_accounts acc ON acc.id=h.account_id WHERE i.symbol=$1`, [symbol]))[0];
const issues = async a => (await a.query('SELECT message FROM wealth_sync_issues')).map(r => r.message);

test('a new legacy stock position (position, then asset) becomes a v2 holding in a v2 account', async () => {
  const { a, uid } = await setup();
  const p = await position(a, uid, { type: 'EQUITY', name: 'LT', ticker: 'LT', platform: 'Angel One', quantity: 5, value: 20925, invested: 19324.7 });
  assert.equal(await holdingOf(a, 'LT'), undefined, 'no instrument yet: waits for the pricing asset');
  await asset(a, uid, p, 'indian_equity', 'LT');
  const h = await holdingOf(a, 'LT');
  assert.deepEqual({ ...h, closed_at: undefined }, { q: 5, inv: 19324.7, status: 'active', closed_at: undefined, account_key: 'angel-one-demat_equity' });
  assert.deepEqual(await issues(a), []);
});

test('quantity changes follow; selling everything closes the holding without deleting it', async () => {
  const { a, uid } = await setup();
  const p = await position(a, uid, { type: 'EQUITY', name: 'ITC', ticker: 'ITC', quantity: 160, invested: 50123 });
  await asset(a, uid, p, 'indian_equity', 'ITC');
  await a.query('UPDATE wealth_positions SET quantity=200, invested_value=61000 WHERE id=$1', [p]);
  assert.equal((await holdingOf(a, 'ITC')).q, 200);
  await a.query('UPDATE wealth_positions SET quantity=0 WHERE id=$1', [p]);
  const h = await holdingOf(a, 'ITC');
  assert.equal(h.status, 'closed');
  assert.ok(h.closed_at);
  assert.equal((await a.query('SELECT count(*)::int n FROM wealth_holdings'))[0].n, 1, 'row kept');
  const v = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.equal(v.accounts.flatMap(x => x.holdings).length, 0, 'closed holdings are not valued');
  await a.query('UPDATE wealth_positions SET quantity=10 WHERE id=$1', [p]);
  assert.equal((await holdingOf(a, 'ITC')).status, 'active', 'buying again reopens it');
});

test('archiving a legacy position closes its holding', async () => {
  const { a, uid } = await setup();
  const p = await position(a, uid, { type: 'US_EQUITY', name: 'NVIDIA', ticker: 'NVDA', platform: 'INDmoney', currency: 'USD', quantity: 0.05 });
  await asset(a, uid, p, 'us_equity', 'NVDA', 'share', 'USD');
  assert.equal((await holdingOf(a, 'NVDA')).account_key, 'indmoney-us_brokerage');
  await a.query(`UPDATE wealth_positions SET record_type='US_EQUITY_ARCHIVED' WHERE id=$1`, [p]);
  assert.equal((await holdingOf(a, 'NVDA')).status, 'closed');
});

test('FD / EPF / credit-card positions append balances; unchanged values add nothing', async () => {
  const { a, uid } = await setup();
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,masked_identifier) VALUES($1,'card','Bank','Card','credit_card','••6136')`, [uid]);
  const fd = await position(a, uid, { type: 'FIXED_DEPOSIT', name: 'Slice FD', institution: 'Slice', platform: 'Slice', value: 3004.41, asOf: '2026-11-10T11:39:00Z' });
  await position(a, uid, { type: 'CREDIT_CARD', category: 'LIABILITY', name: 'Card outstanding', platform: 'Card', value: 30634.21, metadata: { masked_card: '6136' } });
  await a.query(`UPDATE wealth_positions SET updated_at=now() WHERE id=$1`, [fd]);                      // touch, same value
  await a.query(`UPDATE wealth_positions SET current_value=3010.00, balance_as_of='2026-11-12T10:00:00Z' WHERE id=$1`, [fd]);
  const fdBal = await a.query(`SELECT b.balance::float8 v FROM wealth_account_balances b JOIN wealth_accounts x ON x.id=b.account_id WHERE x.account_key='slice-fixed_deposit-slice-fd' ORDER BY b.as_of`);
  assert.deepEqual(fdBal.map(r => r.v), [3004.41, 3010], 'history kept, new value appended, no duplicate for the touch');
  const v = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.equal(v.totals.liabilities, 30634.21, 'card outstanding lands on the existing card account');
});

test('a bank balance written to wealth_accounts is added to v2 balance history', async () => {
  const { a, uid } = await setup();
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,current_balance,balance_as_of,balance_status)
    VALUES($1,'bank-1','Bank','Savings','savings',1000,'2026-11-10T10:00:00Z','verified') RETURNING id, subtype_code`, [uid]);
  assert.equal(acc.subtype_code, 'savings', 'new legacy accounts get their subtype');
  await a.query(`UPDATE wealth_accounts SET current_balance=1250.50, balance_as_of='2026-11-11T10:00:00Z' WHERE id=$1`, [acc.id]);
  await a.query(`UPDATE wealth_accounts SET account_name='Savings ••1' WHERE id=$1`, [acc.id]);           // unrelated change
  const rows = await a.query(`SELECT balance::float8 v, status FROM wealth_account_balances WHERE account_id=$1 ORDER BY as_of`, [acc.id]);
  assert.deepEqual(rows.map(r => [r.v, r.status]), [[1000, 'verified'], [1250.5, 'verified']]);
  const v = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.equal(v.totals.casa, 1250.5);
});

test('fresh legacy prices are mirrored to v2 (USD only with its FX rate), never duplicated', async () => {
  const { a, uid } = await setup();
  const p = await position(a, uid, { type: 'US_EQUITY', name: 'NVIDIA', ticker: 'NVDA', platform: 'INDmoney', currency: 'USD', quantity: 0.5 });
  const as = await asset(a, uid, p, 'us_equity', 'NVDA', 'share', 'USD');
  const write = (price, meta, ts) => a.query(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
    VALUES($1,$2,$3,'USD','StockAnalysis.com real-time quote',$4,now(),'fresh',$5::jsonb)
    ON CONFLICT(asset_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,source_timestamp=EXCLUDED.source_timestamp,metadata=EXCLUDED.metadata,status='fresh'`,
    [as, uid, price, ts, JSON.stringify(meta)]);
  await write(160, {}, '2026-11-11T09:00:00Z');                                  // no FX: not mirrored
  await write(165, { fx_to_inr: 93.9 }, '2026-11-11T10:00:00Z');
  await write(165, { fx_to_inr: 93.9 }, '2026-11-11T10:00:00Z');                // same quote again
  const rows = await a.query(`SELECT price::float8 p, fx_to_inr::float8 fx, source FROM wealth_instrument_prices`);
  assert.deepEqual(rows.map(r => [r.p, r.fx]), [[165, 93.9]]);
  const v = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.equal(v.accounts[0].holdings[0].valuationStatus, 'fresh');
  assert.equal(v.accounts[0].valueInr, Math.round(0.5 * 165 * 93.9 * 100) / 100);
});

test('a failing sync is logged and never blocks the legacy write', async () => {
  const { a, uid } = await setup();
  // A credit-card position whose card account does not exist cannot be placed in v2.
  const id = await position(a, uid, { type: 'CREDIT_CARD', category: 'LIABILITY', name: 'Unknown card', platform: 'X', value: 10, metadata: { masked_card: '9999' } });
  assert.ok(id, 'legacy insert succeeded');
  assert.match((await issues(a))[0], /no matching card account/);
  // An asset with an unsupported class makes the instrument insert fail inside the trigger.
  const p = await position(a, uid, { type: 'EQUITY', name: 'ODD', ticker: 'ODD', quantity: 1 });
  await a.query(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency) VALUES($1,$2,'crypto','ODD','ODD','share','INR')`, [uid, p]);
  assert.ok((await issues(a)).some(m => /check constraint|violates/.test(m)), 'constraint failure recorded');
  assert.equal((await a.query('SELECT count(*)::int n FROM wealth_investment_assets'))[0].n, 1, 'legacy asset row was still written');
});

test('the catch-up sync is idempotent', async () => {
  const { a, uid } = await setup();
  const p = await position(a, uid, { type: 'EQUITY', name: 'HAL', ticker: 'HAL', quantity: 4 });
  await asset(a, uid, p, 'indian_equity', 'HAL');
  const count = async () => (await a.query(`SELECT (SELECT count(*) FROM wealth_holdings)::int h, (SELECT count(*) FROM wealth_accounts)::int a, (SELECT count(*) FROM wealth_account_balances)::int b`))[0];
  const before = await count();
  await a.query('SELECT wealth_sync_position(id) FROM wealth_positions');
  await a.query('SELECT wealth_sync_position(id) FROM wealth_positions');
  assert.deepEqual(await count(), before);
});
