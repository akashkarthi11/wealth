import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { v1Totals, reconcile } from '../../api/_reconcile.js';
import { valuePortfolio } from '../../api/_valuation.js';
import { migratedDb } from './helpers/pglite.mjs';
import { collectIssues } from '../../api/_dataquality.js';
import { startJob, finishJob, jobActivity } from '../../api/_jobs.js';

// Rows shaped like the dashboard's legacy query.
const accounts = [
  { account_key: 'a', bank_name: 'Atom', account_name: 'Savings', account_type: 'savings', currency: 'INR', current_balance: '63420.00', balance_status: 'verified' },
  { account_key: 'b', bank_name: 'BOI', account_name: 'Savings', account_type: 'savings', currency: 'INR', current_balance: '1426.99', balance_status: 'verified' },
  { account_key: 'c', bank_name: 'Slice', account_name: 'Card', account_type: 'credit_card', currency: 'INR', current_balance: null, balance_status: 'unknown' },
  { account_key: 'f', bank_name: 'Multi', account_name: 'FD', account_type: 'fixed_deposit', currency: 'INR', current_balance: '3004', balance_status: 'verified' },
];
const positions = [
  { category: 'INVESTMENT', record_type: 'EQUITY', currency: 'INR', current_value: '20925', metadata: {} },
  { category: 'INVESTMENT', record_type: 'MUTUAL_FUND', currency: 'INR', current_value: '7202', metadata: {} },
  { category: 'INVESTMENT', record_type: 'GOLD', currency: 'INR', current_value: '29416.02', metadata: {} },
  { category: 'INVESTMENT', record_type: 'SILVER', currency: 'INR', current_value: '11688.27', metadata: {} },
  { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: '3004.41', metadata: { reconciliation_status: 'reconciled' } },
  { category: 'INVESTMENT', record_type: 'FIXED_DEPOSIT', currency: 'INR', current_value: '500', metadata: { reconciliation_status: 'pending_reconciliation' } },
  { category: 'INVESTMENT', record_type: 'EPF', currency: 'INR', current_value: '93726', metadata: {} },
  { category: 'INVESTMENT', record_type: 'US_EQUITY', currency: 'USD', current_value: '7.95', market_value_inr: null, metadata: { inr_conversion: { current_value_inr: 746.74 } } },
  { category: 'INVESTMENT', record_type: 'ETF', currency: 'USD', current_value: '26.87', market_value_inr: '2517.00', metadata: {} },
  { category: 'LIABILITY', record_type: 'CREDIT_CARD', currency: 'INR', current_value: '30634.21', metadata: {} },
  { category: 'INVESTMENT', record_type: 'EQUITY_AGGREGATE_ARCHIVED', currency: 'INR', current_value: '222264', metadata: {} },
];

test('server v1Totals equals the live dashboard function in app.js (parity)', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const fn = name => { const s = src.indexOf('function ' + name + '('); let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };
  const ctx = { positions: positions.filter(p => !p.record_type.endsWith('_ARCHIVED')), accounts, accountingTemplate: null, latestAngelOneEquitySummary: null, Number, String, Object };
  vm.runInNewContext([fn('accountKey'), fn('usHoldingInrValue'), fn('wealthPosition')].join('\n') + ';globalThis.w=wealthPosition();', ctx);
  const server = v1Totals(accounts, positions);
  for (const k of ['casa', 'equity', 'mutualFunds', 'gold', 'silver', 'fd', 'pf', 'usPortfolioInr', 'investments', 'liabilities', 'total'])
    assert.equal(Math.round(server[k] * 100), Math.round(ctx.w[k] * 100), k);
});

test('reconcile labels each difference and gates the switch on unexplained ones', () => {
  const v1 = v1Totals(accounts, positions);
  const acc = (id, category, subtype, valueInr) => ({ id, category, subtype, valueInr });
  const v2 = {
    accounts: [acc('sav', 'CASA', 'savings', 64846.99), acc('dm', 'INVESTMENT', 'demat_equity', 20925), acc('mf', 'INVESTMENT', 'mutual_fund', 7202),
      acc('us', 'INVESTMENT', 'us_brokerage', 2517), acc('g', 'INVESTMENT', 'digital_gold', 28484), acc('s', 'INVESTMENT', 'digital_silver', 11688.27),
      acc('fd', 'INVESTMENT', 'fixed_deposit', 3004.41), acc('pf', 'INVESTMENT', 'provident_fund', 93726), acc('cc', 'LIABILITY', 'credit_card', 30634.21)],
    totals: { casa: 64846.99, investments: 0, liabilities: 30634.21, netWorth: 0, excluded: [{ accountId: 'us', symbol: 'NVDA', reason: 'missing_fx' }] },
  };
  const r = reconcile(v1, v2);
  const by = Object.fromEntries(r.differences.map(d => [d.scope, d]));
  assert.equal(by['INVESTMENT/digital_gold'].reason, 'price_basis');
  assert.equal(by['INVESTMENT/us_brokerage'].reason, 'excluded_in_v2');
  assert.ok(!by['CASA'] && !by['LIABILITY'] && !by['INVESTMENT/demat_equity'], 'equal scopes are not listed');
  assert.equal(r.acceptable, true);
  v2.accounts.find(a => a.id === 'pf').valueInr = 90000;
  assert.equal(reconcile(v1, v2).acceptable, false, 'an unexplained balance difference blocks the switch');
});

async function seeded() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const uid = u.id;
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,current_balance,balance_as_of,balance_status)
    VALUES($1,'sav','Bank','Savings','savings',1000,'2026-11-01T00:00:00Z','verified')`, [uid]);
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code) VALUES($1,'fd','Slice','Slice FD','fixed_deposit','fixed_deposit')`, [uid]);
  const [dm] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code) VALUES($1,'mf','Angel One','Mutual funds','mutual_fund','mutual_fund') RETURNING id`, [uid]);
  const [ins] = await a.query(`INSERT INTO wealth_instruments(asset_class,symbol,name,currency,unit) VALUES('indian_mutual_fund','Nippon','Nippon','INR','unit') RETURNING id`);
  await a.query(`INSERT INTO wealth_holdings(account_id,instrument_id,quantity,invested_value,as_of) VALUES($1,$2,29.02,7000,now())`, [dm.id, ins.id]);
  await a.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price) VALUES($1,now(),'MFAPI.in',103.37)`, [ins.id]);
  for (let i = 0; i < 2; i++) await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,occurred_on) VALUES($1,'expense','Food','Awfis',100,'2026-06-28')`, [uid]);
  await a.query(`INSERT INTO wealth_interest_rates(provider,product_key,annual_rate,effective_from,source_url) VALUES('P','slice-savings',0.055,'2026-10-07','x'),('P','slice-savings',0.055,'2026-11-09','x')`);
  return { a, uid };
}

test('data-quality report finds each kind of issue, and accepted issues stop counting as open', async () => {
  const { a, uid } = await seeded();
  const now = Date.parse('2026-11-11T12:00:00Z');
  const r = await collectIssues(uid, { db: a, now, env: { VERCEL_ENV: 'production' } });
  const ids = r.issues.map(i => i.id);
  const has = prefix => assert.ok(ids.some(id => id.startsWith(prefix)), prefix + ' in ' + ids.join(' | '));
  for (const p of ['quantity_suspect:', 'stale_balance:', 'fd_terms:', 'duplicate_tx:', 'open_rates:slice-savings', 'interest_unlinked:', 'unassigned_transactions', 'job:price-refresh:never', 'config:cron_secret']) has(p);
  const q = r.issues.find(i => i.id.startsWith('quantity_suspect:'));
  assert.equal(q.severity, 'high');
  assert.match(q.message, /far below the average cost/);
  const openHigh = r.open.high;
  await a.query(`INSERT INTO wealth_data_quality_acceptances(user_id,issue_id,reason) VALUES($1,$2,'units confirmed later')`, [uid, q.id]);
  const r2 = await collectIssues(uid, { db: a, now, env: { VERCEL_ENV: 'production' } });
  assert.equal(r2.open.high, openHigh - 1);
  assert.equal(r2.issues.find(i => i.id === q.id).accepted, true);
});

test('job runs are recorded and two consecutive failures are flagged', async () => {
  const { a } = await migratedDb();
  for (const status of ['succeeded', 'failed', 'failed']) { const id = await startJob('price-refresh', a); await finishJob(id, status, { n: 1 }, a); }
  const act = await jobActivity(a);
  assert.equal(act.runs.find(r => r.job === 'price-refresh').status, 'failed');
  assert.deepEqual(act.failingTwice, ['price-refresh']);
  const id = await startJob('price-refresh', a); await finishJob(id, 'succeeded', {}, a);
  assert.deepEqual((await jobActivity(a)).failingTwice, []);
});
