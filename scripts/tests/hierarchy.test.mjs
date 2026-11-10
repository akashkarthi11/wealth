import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, applyMigrations } from '../db/migrations-lib.mjs';
import { freshDb, MIGRATIONS_DIR } from './helpers/pglite.mjs';
import { accountHierarchyRows } from '../../api/_queries.js';
import { valuePortfolio } from '../../api/_valuation.js';

const quiet = { log: () => {} };
const all = loadMigrations(MIGRATIONS_DIR);
const upTo = n => all.filter(m => m.id.slice(0, 4) <= n);

// Synthetic legacy data shaped like production (no personal data).
async function legacyDb() {
  const { a } = await freshDb();
  await applyMigrations(a, upTo('0003'), quiet);
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('owner@example.test','x','admin') RETURNING id`);
  const uid = u.id;
  const q = (s, p = []) => a.query(s, [uid, ...p]);
  await q(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,masked_identifier,current_balance,balance_as_of,balance_status) VALUES
    ($1,'bank-sav','Bank','Bank Savings','savings','••1111',1000.50,now(),'verified'),
    ($1,'card-1','Bank','Bank Card','credit_card','••2222',NULL,NULL,'unknown'),
    ($1,'fixed-deposits','Multiple','Fixed Deposits','fixed_deposit',NULL,500,now(),'verified')`);
  const pos = async (type, name, extra = {}) => (await q(`INSERT INTO wealth_positions(user_id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12::jsonb) RETURNING id`,
    [extra.category ?? 'INVESTMENT', extra.institution ?? null, extra.platform ?? 'Broker', type, name, extra.ticker ?? null, extra.currency ?? 'INR',
     extra.quantity ?? null, extra.value ?? 100, extra.invested ?? 90, JSON.stringify(extra.metadata ?? {})]))[0].id;
  const asset = async (positionId, cls, symbol, unit, currency, price, source = 'Yahoo Finance', meta = {}) => {
    const [as] = await q(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
      VALUES($1,$2,$3,$4,$4,$5,$6,'Yahoo Finance',$4,'active') RETURNING id`, [positionId, cls, symbol, unit, currency]);
    await q(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
      VALUES($2,$1,$3,$4,$5,now(),now(),'fresh',$6::jsonb)`, [as.id, price, currency, source, JSON.stringify(meta)]);
  };
  await asset(await pos('EQUITY', 'LT', { platform: 'Broker', ticker: 'LT', quantity: 5, value: 20925 }), 'indian_equity', 'LT', 'share', 'INR', 4185);
  await asset(await pos('EQUITY', 'ITC', { platform: 'Broker', ticker: 'ITC', quantity: 160, value: 44608 }), 'indian_equity', 'ITC', 'share', 'INR', 278.8);
  await asset(await pos('MUTUAL_FUND', 'Some Fund', { platform: 'Broker', quantity: 10, value: 1000 }), 'indian_mutual_fund', 'Some Fund', 'unit', 'INR', 100, 'MFAPI.in');
  await asset(await pos('GOLD', 'Digital Gold', { platform: 'Metals', quantity: 2, value: 28000 }), 'precious_metal', 'GOLD', 'g', 'INR', 14000);
  await asset(await pos('US_EQUITY', 'NVIDIA', { platform: 'USBroker', ticker: 'NVDA', currency: 'USD', quantity: 0.5, value: 80 }), 'us_equity', 'NVDA', 'share', 'USD', 160, 'Yahoo Finance', { fx_to_inr: 88 });
  await pos('FIXED_DEPOSIT', 'Bank FD', { institution: 'Bank', platform: 'Bank', value: 500, metadata: { reconciliation_status: 'reconciled' } });
  await pos('EPF', 'EPF passbook', { institution: 'EPFO', platform: 'EPFO', value: 9000, metadata: { warning: 'future-dated' } });
  await pos('CREDIT_CARD', 'Card outstanding', { category: 'LIABILITY', platform: 'Bank Card', value: 300, metadata: { masked_card: '2222' } });
  await pos('US_PORTFOLIO_AGGREGATE_ARCHIVED', 'US aggregate', { platform: 'USBroker', value: 7000, metadata: { cash_balance: { buying_power_usd: 10.02 } } });
  await pos('EQUITY_AGGREGATE_ARCHIVED', 'Old aggregate', { platform: 'Broker', value: 65533 });
  return { a, uid };
}

test('backfill places every legacy record once in user → account → subtype → data (TR-5.1)', async () => {
  const { a, uid } = await legacyDb();
  await applyMigrations(a, all, quiet);
  const accounts = await a.query(`SELECT subtype_code, bank_name, status FROM wealth_accounts WHERE user_id=$1 ORDER BY subtype_code, bank_name`, [uid]);
  const active = accounts.filter(x => x.status === 'active').map(x => x.subtype_code + ':' + x.bank_name);
  assert.deepEqual(active, ['credit_card:Bank', 'demat_equity:Broker', 'digital_gold:Metals', 'fixed_deposit:Bank', 'mutual_fund:Broker', 'provident_fund:EPFO', 'savings:Bank', 'us_brokerage:USBroker']);
  assert.ok(accounts.some(x => x.subtype_code === null && x.status === 'merged'), 'duplicate fixed-deposits account is merged, not deleted');
  assert.equal((await a.query('SELECT count(*)::int n FROM wealth_holdings'))[0].n, 5);
  assert.equal((await a.query('SELECT count(*)::int n FROM wealth_instruments'))[0].n, 5);
});

test('backfilled model values reproduce the legacy figures', async () => {
  const { a, uid } = await legacyDb();
  await applyMigrations(a, all, quiet);
  const r = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.equal(r.totals.casa, 1000.50);
  // LT 20925 + ITC 44608 + fund 1000 + gold 28000 + NVDA 0.5×160×88=7040 + FD 500 + EPF 9000 + US cash 10.02×88
  assert.equal(r.totals.investments, Math.round((20925 + 44608 + 1000 + 28000 + 7040 + 500 + 9000 + 10.02 * 88) * 100) / 100);
  assert.equal(r.totals.liabilities, 300, 'card outstanding attached to the existing card account');
  assert.equal(r.totals.excluded.length, 0);
  const archived = r.accounts.flatMap(x => x.holdings).filter(h => /aggregate/i.test(h.name));
  assert.equal(archived.length, 0, 'archived aggregates never become holdings');
});

test('backfill is idempotent', async () => {
  const { a, uid } = await legacyDb();
  await applyMigrations(a, all, quiet);
  const migration = all.find(m => m.id.startsWith('0004'));
  await a.exec(migration.sql);   // run the body again directly
  assert.equal((await a.query('SELECT count(*)::int n FROM wealth_holdings'))[0].n, 5);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_accounts WHERE user_id=$1 AND status='active' AND subtype_code IS NOT NULL`, [uid]))[0].n, 8);
});

test('backfill aborts if a holding cannot be carried over', async () => {
  const { a, uid } = await legacyDb();
  // A priced position whose asset class has no instrument mapping path (no asset row) cannot be placed.
  await a.query(`INSERT INTO wealth_positions(user_id,category,platform_name,record_type,name,ticker,currency,quantity,current_value)
    VALUES($1,'INVESTMENT','Broker','EQUITY','ORPHAN','ORPHAN','INR',1,10)`, [uid]);
  await assert.rejects(applyMigrations(a, all, quiet), /Backfill incomplete/);
  const n = (await a.query(`SELECT count(*)::int n FROM wealth_schema_migrations WHERE id LIKE '0004%'`))[0].n;
  assert.equal(n, 0, 'nothing recorded when the backfill fails');
});

test('v2 "add FD" creates a fixed_deposit account with its first balance, once (TR-5.6)', async () => {
  const { createFixedDepositAccount } = await import('../../api/_queries.js');
  const { a, uid } = await legacyDb();
  await applyMigrations(a, all, quiet);
  const fd = { key: 'angel-one-fixed_deposit-new-fd', institution: 'Angel One', name: 'New FD', balance: 2500.5, note: 'Invested ₹2500.00 · 8% p.a.' };
  const r = await createFixedDepositAccount(uid, fd, a);
  assert.equal(r.balance, 2500.5);
  assert.equal(r.status, 'reported');
  await assert.rejects(createFixedDepositAccount(uid, fd, a), e => e.code === '23505' || /duplicate key/.test(e.message));
  const v = valuePortfolio(await accountHierarchyRows(uid, a));
  assert.ok(v.accounts.some(x => x.subtype === 'fixed_deposit' && x.name === 'New FD' && x.valueInr === 2500.5));
});
