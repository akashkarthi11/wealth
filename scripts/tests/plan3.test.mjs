// TSD Claude Plan 3: ingest APIs (Phase 2), corrections (Phase 1), interest engine (Phase 3), obligations (Phase 5),
// audit and backups (Phase 6), and the single-function router. In-memory PostgreSQL only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migratedDb, adapter, MIGRATIONS_DIR } from './helpers/pglite.mjs';
import { loadMigrations, applyMigrations } from '../db/migrations-lib.mjs';
import { storePrices, recordEmailImport, seenMessages, recordBalance, updateHolding, createAccount, setFdTerms, markDuplicate, suggestAccounts, assignAccounts } from '../../api/_ingest.js';
import { planAccrual, runAccrual, submitRate, recordCredit, interestOverview, dayCount, fdPrincipal, round8, round2, estimatedBalance } from '../../api/_interest.js';
import { spendingRows, obligationsByAccount } from '../../api/_queries.js';
import { collectIssues } from '../../api/_dataquality.js';
import { encryptBackup, decryptBackup, dumpDatabase } from '../../api/_backup.js';
import { restoreAll } from '../db/restore-lib.mjs';
import { ROUTES, resolveRoute } from '../../api/router.js';
import { refreshSkipReason } from '../../api/_routes/refresh-market-prices.js';

const NOW = Date.parse('2026-11-11T06:00:00Z');   // 11:30 IST on 11 Nov → accrue through 10 Nov

async function setup() {
  const { db, a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  return { db, a, uid: u.id };
}
const account = (a, uid, key, subtype, extra = {}) => a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency)
  VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING id`, [uid, key, extra.bank ?? 'Bank', extra.name ?? key, subtype, extra.currency ?? 'INR']).then(r => r[0].id);
async function stock(a, uid, { symbol = 'LT', qty = 5, cls = 'indian_equity', currency = 'INR', platform = 'Angel One', type = 'EQUITY', invested = 19000 } = {}) {
  const [p] = await a.query(`INSERT INTO wealth_positions(user_id,category,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,metadata)
    VALUES($1,'INVESTMENT',$2,$3,$4,$4,$5,$6,20000,$7,'2026-11-10T09:00:00Z','{}') RETURNING id`, [uid, platform, type, symbol, currency, qty, invested]);
  await a.query(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
    VALUES($1,$2,$3,$4,$4,'share',$5,'Yahoo Finance',$4,'active')`, [uid, p.id, cls, symbol, currency]);
  const [h] = await a.query(`SELECT h.account_id, h.instrument_id FROM wealth_holdings h JOIN wealth_instruments i ON i.id=h.instrument_id WHERE i.symbol=$1`, [symbol]);
  return { positionId: p.id, ...h };
}

// ── Router ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('one function serves every /api route: rewrite parameter or path, query kept, every handler loads', async () => {
  assert.deepEqual(resolveRoute('/api/router?__route=interest%2Frates&dryRun=1'), { route: 'interest/rates', cleanUrl: '/api/interest/rates?dryRun=1' });
  assert.deepEqual(resolveRoute('/api/email-imports/seen?ids=a,b'), { route: 'email-imports/seen', cleanUrl: '/api/email-imports/seen?ids=a%2Cb' });
  for (const [name, load] of Object.entries(ROUTES)) assert.equal(typeof (await load()).default, 'function', name);
  const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(cfg.functions), ['api/router.js'], 'only the router is a function');
  assert.ok(cfg.crons.length <= 2, 'Hobby plan: at most two cron jobs');
  for (const c of cfg.crons) assert.ok(ROUTES[c.path.replace('/api/', '')], c.path + ' is routed');
  const { readdirSync } = await import('node:fs');
  const functions = readdirSync(new URL('../../api/', import.meta.url)).filter(f => !f.startsWith('_'));
  assert.deepEqual(functions, ['router.js'], 'Hobby plan: every other file under api/ must start with "_" (one function per deployment)');
});

// ── Phase 2: prices ────────────────────────────────────────────────────────────────────────────────────────────
test('prices: newest-only, USD needs FX, live sources only, held instruments refused; legacy kept in step and audited', async () => {
  const { a, uid } = await setup();
  await stock(a, uid);
  const item = { assetClass: 'indian_equity', symbol: 'LT', price: 4200, currency: 'INR', asOf: '2026-11-10T10:00:00Z', source: 'NSE' };
  let r = await storePrices(uid, [item], { db: a, now: NOW });
  assert.equal(r.results[0].status, 'stored');
  assert.equal(r.results[0].legacyRows, 1);
  assert.equal((await storePrices(uid, [item], { db: a, now: NOW })).results[0].status, 'already_stored');
  assert.equal((await storePrices(uid, [{ ...item, asOf: '2026-11-09T10:00:00Z' }], { db: a, now: NOW })).results[0].status, 'older_than_latest');
  r = await storePrices(uid, [{ ...item, source: 'Screenshot' }, { ...item, symbol: 'NOPE', asOf: '2026-11-10T11:00:00Z' }, { ...item, asOf: '2026-11-12T10:00:00Z' }], { db: a, now: NOW });
  assert.deepEqual(r.results.map(x => x.status), ['rejected', 'rejected', 'rejected']);
  const [mp] = await a.query(`SELECT unit_price::float8 p, status FROM wealth_market_prices`);
  assert.deepEqual(mp, { p: 4200, status: 'fresh' });
  const [audit] = await a.query(`SELECT actor FROM wealth_audit_log WHERE table_name='wealth_positions' LIMIT 1`);
  assert.ok(audit, 'positions are audited');

  await stock(a, uid, { symbol: 'NVDA', cls: 'us_equity', currency: 'USD', platform: 'INDmoney', type: 'US_EQUITY', qty: 0.05 });
  const usd = { assetClass: 'us_equity', symbol: 'NVDA', price: 180, currency: 'USD', asOf: '2026-11-10T20:00:00Z', source: 'Yahoo Finance' };
  assert.match((await storePrices(uid, [usd], { db: a, now: NOW })).results[0].reason, /fxToInr/);
  assert.equal((await storePrices(uid, [{ ...usd, fxToInr: 88.5 }], { db: a, now: NOW })).results[0].status, 'stored');
  const [p] = await a.query(`SELECT fx_to_inr::float8 fx FROM wealth_instrument_prices p JOIN wealth_instruments i ON i.id=p.instrument_id WHERE i.symbol='NVDA'`);
  assert.equal(p.fx, 88.5);

  await a.query(`UPDATE wealth_instruments SET price_hold_reason='units under review' WHERE symbol='LT'`);
  assert.equal((await storePrices(uid, [{ ...item, asOf: '2026-11-10T12:00:00Z' }], { db: a, now: NOW })).results[0].status, 'on_hold');
  assert.equal((await storePrices(uid, [{ ...usd, fxToInr: 88.5, asOf: '2026-11-10T21:00:00Z' }], { db: a, now: NOW, dryRun: true })).results[0].status, 'would_store');
  const [{ n }] = await a.query(`SELECT count(*)::int n FROM wealth_audit_log WHERE table_name='wealth_positions' AND actor='external'`);
  assert.ok(n >= 1, 'direct SQL is audited as external');
});

// ── Phase 2: Gmail imports ─────────────────────────────────────────────────────────────────────────────────────
test('email imports: idempotent per message, own bank/card accounts only, earlier identical movement matched', async () => {
  const { a, uid } = await setup();
  const sav = await account(a, uid, 'sav', 'savings');
  const mf = await account(a, uid, 'mf', 'mutual_fund');
  let r = await recordEmailImport(uid, { messageId: 'm1', outcome: 'ignored' }, { db: a });
  assert.equal(r.status, 201);
  r = await recordEmailImport(uid, { messageId: 'm1', outcome: 'import', transactions: [] }, { db: a });
  assert.equal(r.body.result, 'already_recorded', 'a seen message is never processed again');
  const tx = { kind: 'expense', category: 'Food', description: 'Cafe', amount: 250, accountId: sav, occurredOn: '2026-11-10' };
  await assert.rejects(recordEmailImport(uid, { messageId: 'm2', outcome: 'import', transactions: [{ ...tx, accountId: mf }] }, { db: a }), /savings, current or credit-card/);
  r = await recordEmailImport(uid, { messageId: 'm2', outcome: 'import', transactions: [tx] }, { db: a });
  assert.equal(r.body.importStatus, 'imported');
  const [t] = await a.query(`SELECT external_ref FROM wealth_transactions`);
  assert.equal(t.external_ref, 'gmail:m2');
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,amount,account_id,occurred_on) VALUES($1,'expense','Fuel',900,$2,'2026-11-09')`, [uid, sav]);
  r = await recordEmailImport(uid, { messageId: 'm3', outcome: 'import', transactions: [{ ...tx, category: 'Fuel', amount: 900, occurredOn: '2026-11-09' }] }, { db: a });
  assert.equal(r.body.importStatus, 'matched_existing');
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions`))[0].n, 2);
  assert.deepEqual((await seenMessages(uid, 'm1,m2,m9', { db: a })).seen.sort(), ['m1', 'm2']);
});

// ── Phase 2 / Phase 1: balances, holdings, accounts ────────────────────────────────────────────────────────────
test('balances append history and keep legacy bank columns in step; holdings accounts are refused', async () => {
  const { a, uid } = await setup();
  const sav = await account(a, uid, 'sav', 'savings');
  const r = await recordBalance(uid, { accountId: sav, balance: 47882, asOf: '2026-11-10T19:48:00Z', status: 'verified', note: 'screenshot' }, { db: a, now: NOW });
  assert.deepEqual({ stored: r.stored, legacy: r.legacyUpdated }, { stored: true, legacy: true });
  assert.equal((await recordBalance(uid, { accountId: sav, balance: 47882, asOf: '2026-11-10T19:48:00Z' }, { db: a, now: NOW })).result, 'already_stored');
  const [acc] = await a.query(`SELECT current_balance::float8 b, balance_status FROM wealth_accounts WHERE id=$1`, [sav]);
  assert.deepEqual(acc, { b: 47882, balance_status: 'verified' });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_account_balances WHERE account_id=$1`, [sav]))[0].n, 1, 'legacy trigger did not add a second row');
  const dm = await account(a, uid, 'dm', 'demat_equity');
  await assert.rejects(recordBalance(uid, { accountId: dm, balance: 1 }, { db: a, now: NOW }), /Balances are recorded only/);
  const [other] = await a.query(`INSERT INTO wealth_users(email,password_hash) VALUES('x@example.test','x') RETURNING id`);
  await assert.rejects(recordBalance(other.id, { accountId: sav, balance: 1 }, { db: a, now: NOW }), /Account not found/);
});

test('quantity correction goes through the legacy position (kept in step by Phase B), records evidence, can release a price hold', async () => {
  const { a, uid } = await setup();
  const h = await stock(a, uid, { symbol: 'NIPPON', cls: 'indian_mutual_fund', type: 'MUTUAL_FUND', qty: 29.02, invested: 7000 });
  await a.query(`UPDATE wealth_instruments SET price_hold_reason='DQ-1' WHERE id=$1`, [h.instrument_id]);
  await assert.rejects(updateHolding(uid, { accountId: h.account_id, instrumentId: h.instrument_id, quantity: 69.7 }, { db: a, now: NOW }), /evidence/);
  const r = await updateHolding(uid, { accountId: h.account_id, instrumentId: h.instrument_id, quantity: 69.68, evidence: 'Angel One MF statement 10 Nov', releasePriceHold: true }, { db: a, now: NOW });
  assert.equal(r.previous.quantity, 29.02);
  assert.equal(r.holding.quantity, 69.68);
  const [p] = await a.query(`SELECT quantity::float8 q, metadata->'quantity_corrections'->0->>'evidence' ev FROM wealth_positions WHERE id=$1`, [h.positionId]);
  assert.deepEqual(p, { q: 69.68, ev: 'Angel One MF statement 10 Nov' });
  assert.equal((await a.query(`SELECT price_hold_reason FROM wealth_instruments WHERE id=$1`, [h.instrument_id]))[0].price_hold_reason, null);
});

test('accounts: create with FD terms, duplicates refused, terms validated and updated', async () => {
  const { a, uid } = await setup();
  const { account: fd } = await createAccount(uid, { subtype: 'fixed_deposit', institution: 'Slice', name: 'FD 2', fdTerms: { principal: 3000, bookedOn: '2026-10-01', maturityOn: '2027-10-01', payout: 'cumulative', compounding: 'quarterly' } }, { db: a });
  assert.equal(fd.account_key, 'slice-fixed_deposit-fd-2');
  await assert.rejects(createAccount(uid, { subtype: 'fixed_deposit', institution: 'Slice', name: 'FD 2' }, { db: a }), /already exists/);
  await assert.rejects(setFdTerms(uid, { accountId: fd.id, fdTerms: { bookedOn: '2026-10-01', maturityOn: '2026-09-01' } }, { db: a }), /after bookedOn/);
  const r = await setFdTerms(uid, { accountId: fd.id, fdTerms: { payout: 'monthly' } }, { db: a });
  assert.deepEqual({ p: r.account.principal, payout: r.account.payout }, { p: 3000, payout: 'monthly' });
});

test('duplicates are marked (not deleted) and leave spending totals and the data-quality list; unassigned get suggestions', async () => {
  const { a, uid } = await setup();
  const sav = await account(a, uid, 'sav', 'savings', { bank: 'Atom', name: 'Savings' });
  const ins = d => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,occurred_on,account_id) VALUES($1,'expense','Rent',$2,950,'2026-11-01',$3) RETURNING id`, [uid, d, sav]).then(r => r[0].id);
  const [x, y] = [await ins('Zarivault rent'), await ins('Zarivault rent')];
  const before = (await collectIssues(uid, { db: a, now: NOW, env: {} })).issues.filter(i => i.category === 'duplicate_candidate').length;
  await markDuplicate(uid, { transactionId: y, duplicateOf: x }, { db: a });
  const total = (await spendingRows(uid, a)).reduce((s, r) => s + r.total, 0);
  assert.equal(total, 950);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions`))[0].n, 2, 'both rows kept');
  const after = (await collectIssues(uid, { db: a, now: NOW, env: {} })).issues.filter(i => i.category === 'duplicate_candidate').length;
  assert.deepEqual([before, after], [1, 0]);
  await assert.rejects(markDuplicate(uid, { transactionId: x, duplicateOf: x }, { db: a }), /itself/);
  await markDuplicate(uid, { transactionId: y, duplicateOf: null }, { db: a });
  assert.equal((await spendingRows(uid, a)).reduce((s, r) => s + r.total, 0), 1900, 'unmarking counts it again');

  const [u] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,occurred_on) VALUES($1,'expense','Rent','Zarivault rent Dec',950,'2026-12-01') RETURNING id`, [uid]);
  const s = await suggestAccounts(uid, { db: a });
  assert.deepEqual(s.suggestions.map(x => [x.transactionId, x.accountId]), [[u.id, sav]]);
  assert.equal((await assignAccounts(uid, [{ transactionId: u.id, accountId: sav }], { db: a })).assigned, 1);
  assert.equal((await assignAccounts(uid, [{ transactionId: u.id, accountId: sav }], { db: a })).assigned, 0, 'already assigned rows are left alone');
});

// ── Phase 3: interest engine (pure) ────────────────────────────────────────────────────────────────────────────
const rate = (id, r, from, to = null) => ({ id, annual_rate: r, effective_from: from, effective_to: to, source_url: 'https://bank.example/rates' });
const bal = (asOf, b, status = 'verified') => ({ as_of: asOf, balance: b, status });

test('accrual: formula and rounding match the existing ledger rows; leap years use 366', () => {
  assert.equal(round8(47875 * 0.055 / 365), 7.2140411, 'same as the 9 Nov estimated row');
  assert.equal(dayCount('2028-02-29'), 366);
  assert.equal(dayCount('2026-11-10'), 365);
  const plan = planAccrual({ kind: 'savings', balances: [bal('2028-02-28T10:00:00Z', 10000)], rates: [rate('r', 0.0366, '2028-01-01')], ledger: [], through: '2028-02-29' });
  assert.deepEqual(plan.rows.map(r => [r.accrual_date, r.day_count, r.interest_amount]), [['2028-02-28', 366, 1], ['2028-02-29', 366, 1]]);
});

test('accrual: catches up missed days, follows a mid-period rate change, skips stale principal, never accrues today', () => {
  const balances = ['2026-11-01', '2026-11-03', '2026-11-05'].map(d => bal(d + 'T04:00:00Z', 10000));
  const rates = [rate('r1', 0.05, '2026-10-01', '2026-11-03'), rate('r2', 0.06, '2026-11-04')];
  const ledger = [{ id: 'l0', accrual_date: '2026-10-31', revision: 1, interest_amount: 1.36986301, calculation_status: 'confirmed' }];
  const plan = planAccrual({ kind: 'savings', balances, rates, ledger, through: '2026-11-10' });
  const days = plan.rows.map(r => [r.accrual_date, r.annual_rate]);
  assert.deepEqual(days, [['2026-11-01', 0.05], ['2026-11-02', 0.05], ['2026-11-03', 0.05], ['2026-11-04', 0.06], ['2026-11-05', 0.06], ['2026-11-06', 0.06], ['2026-11-07', 0.06]]);
  assert.deepEqual(plan.skipped.map(s => s.day), ['2026-11-08', '2026-11-09', '2026-11-10'], 'principal older than 2 days');
  assert.ok(plan.skipped.every(s => s.reason === 'stale balance'));
});

test('accrual: changed inputs append a correction revision; bank-confirmed days are never corrected', () => {
  const balances = [bal('2026-11-08T04:00:00Z', 20000)];
  const rates = [rate('r', 0.0365, '2026-10-01')];
  const ledger = [
    { id: 'a8', accrual_date: '2026-11-08', revision: 1, interest_amount: 1.5, calculation_status: 'estimated' },
    { id: 'a9', accrual_date: '2026-11-09', revision: 1, interest_amount: 1.5, calculation_status: 'confirmed' },
  ];
  const plan = planAccrual({ kind: 'savings', balances, rates, ledger, through: '2026-11-09' });
  assert.deepEqual(plan.rows.map(r => [r.accrual_date, r.entry_type, r.revision, r.supersedes_id, r.interest_amount]), [['2026-11-08', 'correction', 2, 'a8', 0.5]]);
  const again = planAccrual({ kind: 'savings', balances, rates, ledger: [...ledger, { id: 'c8', accrual_date: '2026-11-08', revision: 2, interest_amount: 0.5, calculation_status: 'corrected' }], through: '2026-11-09' });
  assert.equal(again.rows.length, 0, 'a correction is written once');
});

test('FD accrual: pending without terms, stops at maturity, compounds cumulative deposits', () => {
  const rates = [rate('f', 0.08, '2026-01-01')];
  assert.equal(planAccrual({ kind: 'fd', rates, terms: { principal: null }, through: '2026-11-10' }).status, 'pending_terms');
  const p = planAccrual({ kind: 'fd', rates, terms: { principal: 1000, bookedOn: '2026-11-01', maturityOn: '2026-11-05', payout: 'monthly' }, through: '2026-11-10' });
  assert.deepEqual(p.rows.map(r => r.accrual_date), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.equal(p.rows[0].interest_amount, round8(1000 * 0.08 / 365));
  assert.equal(fdPrincipal({ principal: 1000, bookedOn: '2026-01-15', payout: 'cumulative', compounding: 'quarterly' }, '2026-07-20', 0.08), 1040.4);
});

// ── Phase 3: engine against the database ──────────────────────────────────────────────────────────────────────
async function interestFixture() {
  const { a, uid } = await setup();
  const [prod] = await a.query(`INSERT INTO wealth_interest_products(product_key,provider) VALUES('slice-savings','Slice Small Finance Bank') RETURNING id`);
  const sav = await account(a, uid, 'slice-savings-3731', 'savings', { bank: 'Slice', name: 'Slice Savings' });
  await account(a, uid, 'boi-savings', 'savings', { bank: 'Bank of India', name: 'BOI Savings' });
  await a.query(`INSERT INTO wealth_interest_links(account_id,product_id) VALUES($1,$2)`, [sav, prod.id]);
  await a.query(`INSERT INTO wealth_interest_rates(provider,product_key,annual_rate,effective_from,source_url) VALUES('Slice Small Finance Bank','slice-savings',0.055,'2026-10-07','https://slice.example')`);
  await a.query(`INSERT INTO wealth_interest_ledger(user_id,provider,product_key,account_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,source_url,calculation_status)
    VALUES($1,'Slice Small Finance Bank','slice-savings','slice-savings-3731','2026-11-09',47875,0.055,365,7.21,'accrual','x','confirmed')`, [uid]);
  await a.query(`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-09T19:48:00Z',47882,'verified')`, [sav]);
  return { a, uid, sav };
}

test('nightly run writes yesterday once, reports unlinked accounts, and is idempotent', async () => {
  const { a, uid } = await interestFixture();
  const dry = await runAccrual(uid, { db: a, now: NOW, dryRun: true });
  assert.equal(dry.accounts[0].rowsPlanned, 1);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_interest_ledger`))[0].n, 1, 'dry run writes nothing');
  const r = await runAccrual(uid, { db: a, now: NOW });
  assert.equal(r.through, '2026-11-10');
  const slice = r.accounts.find(x => x.accountKey === 'slice-savings-3731');
  assert.deepEqual([slice.status, slice.rowsWritten, slice.interestTotal], ['calculated', 1, round8(47882 * 0.055 / 365)]);
  assert.equal(r.accounts.find(x => x.accountKey === 'boi-savings').status, 'needs_link');
  const [row] = await a.query(`SELECT accrual_date::text d, principal::float8 p, account_id IS NOT NULL acc, product_id IS NOT NULL prod FROM wealth_interest_ledger WHERE accrual_date='2026-11-10'`);
  assert.deepEqual(row, { d: '2026-11-10', p: 47882, acc: true, prod: true });
  assert.equal((await runAccrual(uid, { db: a, now: NOW })).accounts[0].rowsWritten, 0, 'second run adds nothing');
  const [{ actor }] = await a.query(`SELECT actor FROM wealth_audit_log WHERE table_name='wealth_interest_ledger' AND action='insert' ORDER BY id DESC LIMIT 1`);
  assert.equal(actor, 'cron');
  const view = await interestOverview(uid, { db: a, now: NOW });
  assert.equal(view.sources[0].rate, 0.055);
  assert.equal(view.unlinked[0].bank_name, 'Bank of India');
});

test('rate submissions close the previous period and never duplicate; credits need a unique reference', async () => {
  const { a, uid, sav } = await interestFixture();
  assert.equal((await submitRate({ productKey: 'slice-savings', annualRate: 0.055, effectiveFrom: '2026-11-09', sourceUrl: 'u' }, { db: a })).body.result, 'unchanged');
  await assert.rejects(submitRate({ productKey: 'nope', annualRate: 0.05, effectiveFrom: '2026-11-09', sourceUrl: 'u' }, { db: a }), /Unknown productKey/);
  await assert.rejects(submitRate({ productKey: 'slice-savings', annualRate: 0.05, effectiveFrom: '2026-10-01', sourceUrl: 'u' }, { db: a }), /after the current period/);
  const r = await submitRate({ productKey: 'slice-savings', annualRate: 0.05, effectiveFrom: '2026-12-01', sourceUrl: 'https://slice.example/new', evidence: 'rate page' }, { db: a });
  assert.equal(r.status, 201);
  const periods = await a.query(`SELECT annual_rate::float8 r, effective_from::text f, effective_to::text t FROM wealth_interest_rates ORDER BY effective_from`);
  assert.deepEqual(periods, [{ r: 0.055, f: '2026-10-07', t: '2026-11-30' }, { r: 0.05, f: '2026-12-01', t: null }]);

  const c = await recordCredit(uid, { accountId: sav, amount: 215.4, creditedOn: '2026-11-30', newBalance: 48097.4, balanceAsOf: '2026-11-30T10:00:00Z' }, { db: a });
  assert.equal(c.reference, 'interest:slice-savings-3731:2026-11-30:215.40');
  await assert.rejects(recordCredit(uid, { accountId: sav, amount: 215.4, creditedOn: '2026-11-30' }, { db: a }), /already recorded/);
  const [acc] = await a.query(`SELECT current_balance::float8 b FROM wealth_accounts WHERE id=$1`, [sav]);
  assert.equal(acc.b, 48097.4);
});

// ── Migration 0008 on existing data ────────────────────────────────────────────────────────────────────────────
test('0008 closes the older of two open rate periods and links known interest accounts, without deleting', async () => {
  const db = new PGlite(), a = adapter(db);
  const all = loadMigrations(MIGRATIONS_DIR);
  await applyMigrations(a, all.filter(m => m.id < '0008'), { log: () => {} });
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type) VALUES($1,'atom-savings','Atom','Atom Savings','savings')`, [u.id]);
  await a.query(`INSERT INTO wealth_interest_rates(provider,product_key,annual_rate,effective_from,source_url) VALUES
    ('Slice Small Finance Bank','slice-savings',0.055,'2026-10-07','a'),('Slice Small Finance Bank','slice-savings',0.055,'2026-11-09','b'),
    ('Slice Small Finance Bank','atom-savings',0.055,'2026-10-07','c')`);
  await applyMigrations(a, all, { log: () => {} });
  const periods = await a.query(`SELECT effective_from::text f, effective_to::text t FROM wealth_interest_rates WHERE product_key='slice-savings' ORDER BY 1`);
  assert.deepEqual(periods, [{ f: '2026-10-07', t: '2026-11-08' }, { f: '2026-11-09', t: null }]);
  const links = await a.query(`SELECT a.account_key, p.product_key FROM wealth_interest_links l JOIN wealth_accounts a ON a.id=l.account_id JOIN wealth_interest_products p ON p.id=l.product_id`);
  assert.deepEqual(links, [{ account_key: 'atom-savings', product_key: 'atom-savings' }]);
});

// ── Phase 5: obligations ───────────────────────────────────────────────────────────────────────────────────────
test('legacy bills and mandates keep obligations and occurrences in step; the read model has one row per obligation', async () => {
  const { a, uid } = await setup();
  const sav = await account(a, uid, 'sav', 'savings', { bank: 'HDFC', name: 'Savings' });
  const [b] = await a.query(`INSERT INTO wealth_planned_bills(user_id,title,amount,due_date,category,account_id,bill_key) VALUES($1,'LIC premium',5000,'2026-11-15','Insurance',$2,'lic') RETURNING id, obligation_id`, [uid, sav]);
  assert.ok(b.obligation_id, 'bill linked to a new obligation');
  const occ = () => a.query(`SELECT status, planned_bill_id FROM wealth_payment_occurrences WHERE obligation_id=$1`, [b.obligation_id]);
  assert.deepEqual(await occ(), [{ status: 'planned', planned_bill_id: b.id }]);
  await a.query(`UPDATE wealth_planned_bills SET status='paid' WHERE id=$1`, [b.id]);
  assert.equal((await occ())[0].status, 'paid');
  const [s] = await a.query(`INSERT INTO wealth_subscriptions(user_id,provider_key,provider_name,mandate_key,amount,frequency,next_due_date,source_account_id) VALUES($1,'netflix','Netflix','m1',649,'monthly','2026-11-20',$2) RETURNING id`, [uid, sav]);
  const [{ obligation_id }] = await a.query(`SELECT obligation_id FROM wealth_subscriptions WHERE id=$1`, [s.id]);
  assert.ok(obligation_id, 'mandate linked to its obligation');
  await a.query(`UPDATE wealth_subscriptions SET status='cancelled' WHERE id=$1`, [s.id]);
  assert.equal((await a.query(`SELECT status FROM wealth_recurring_obligations WHERE id=$1`, [obligation_id]))[0].status, 'cancelled');
  await a.query(`UPDATE wealth_subscriptions SET status='active' WHERE id=$1`, [s.id]);
  const view = await obligationsByAccount(uid, a);
  assert.equal(view.accounts.length, 1);
  assert.deepEqual(view.accounts[0].obligations.map(o => o.title).sort(), ['LIC premium', 'Netflix']);
  assert.deepEqual(await a.query(`SELECT message FROM wealth_sync_issues`), []);
});

// ── Phase 6: backups ───────────────────────────────────────────────────────────────────────────────────────────
test('backup: encrypted, tamper-evident, wrong key refused, and restores into a fresh database with every row', async () => {
  const { a, uid } = await interestFixture();
  await recordEmailImport(uid, { messageId: 'm1', outcome: 'ignored' }, { db: a });
  const key = 'k'.repeat(40);
  const dump = await dumpDatabase(a, new Date(NOW));
  const buf = encryptBackup(dump, key);
  assert.ok(!buf.includes(Buffer.from('slice-savings')), 'content is not readable without the key');
  assert.throws(() => decryptBackup(buf, 'x'.repeat(40)));
  const bad = Buffer.from(buf); bad[bad.length - 1] ^= 1;
  assert.throws(() => decryptBackup(bad, key), 'a changed byte is detected');
  assert.throws(() => encryptBackup(dump, 'short'), /at least 32/);
  const back = decryptBackup(buf, key);
  const { db: target } = await migratedDb();
  const counts = await restoreAll(target, back);
  for (const [t, n] of Object.entries(dump.manifest.counts)) assert.equal(counts[t], n, t);
  const [{ n }] = (await target.query(`SELECT count(*)::int n FROM wealth_audit_log`)).rows;
  assert.equal(n, dump.manifest.counts.wealth_audit_log, 'triggers were off during the restore');
});

test('daily refresh leaves held instruments and (by default) metal futures alone', () => {
  assert.match(refreshSkipReason({ symbol: 'LT.NS', holdReason: 'DQ-1' }, {}), /on hold/);
  assert.match(refreshSkipReason({ symbol: 'GC=F' }, {}), /India benchmark/);
  assert.equal(refreshSkipReason({ symbol: 'GC=F' }, { WEALTH_METAL_PRICE_SOURCE: 'futures' }), null);
  assert.equal(refreshSkipReason({ symbol: 'LT.NS' }, {}), null);
});

test('interest view: a day with correction revisions shows the sum of its rows (9 Nov 2026 Slice Savings = 7.21)', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const s = src.indexOf('function interestLatestLedger(');
  let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  const row = (rev, amt) => ({ product_key: 'slice-savings', account_key: 'slice-savings-3731', accrual_date: '2026-11-09', revision: rev, interest_amount: amt });
  const ctx = { interestRows: [row(1, '7.21404110'), row(2, '7.21000000'), row(3, '-7.21404110')], Map, Number, Math };
  vm.runInNewContext(src.slice(s, i + 1) + ';globalThis.out=interestLatestLedger();', ctx);
  assert.equal(ctx.out.length, 1);
  assert.equal(ctx.out[0].interest_amount, 7.21);
  assert.equal(ctx.out[0].revision, 3);
});

test('interest month total = statement through its end date + ledger days after it (Nov 2026 real figures)', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const fn = name => { const s = src.indexOf('function ' + name + '('); let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };
  const led = (p, a, d, amt, rev = 1) => ({ product_key: p, account_key: a, accrual_date: d, revision: rev, interest_amount: amt });
  const ctx = {
    interestStatements: [
      { product_key: 'slice-savings', period_start: '2026-11-01', period_end: '2026-11-09', statement_total: '64.36' },
      { product_key: 'atom-savings', period_start: '2026-11-01', period_end: '2026-11-09', statement_total: '66.80' }],
    interestRows: [led('slice-savings', 's', '2026-11-08', '7.20'), led('slice-savings', 's', '2026-11-09', '7.21404110'), led('slice-savings', 's', '2026-11-09', '7.21', 2),
      led('slice-savings', 's', '2026-11-09', '-7.21404110', 3), led('slice-savings', 's', '2026-11-10', '7.21509589'),
      led('atom-savings', 'a', '2026-11-09', '9.56'), led('atom-savings', 'a', '2026-11-10', '9.55643836')],
    Map, Number, Math, String,
  };
  vm.runInNewContext([fn('interestStatementFor'), fn('interestLatestLedger'), fn('interestMonthTotal')].join('\n') +
    ";globalThis.s=interestMonthTotal('slice-savings');globalThis.a=interestMonthTotal('atom-savings');", ctx);
  assert.deepEqual({ ...ctx.s }, { month: '2026-11', statementThrough: '2026-11-09', total: 71.58 }, '64.36 + 7.21509589');
  assert.equal(ctx.a.total, 76.36, '66.80 + 9.55643836');
  ctx.interestRows.push(led('slice-savings', 's', '2026-12-01', '7.30'));
  vm.runInNewContext(";globalThis.s=interestMonthTotal('slice-savings');", ctx);
  assert.deepEqual({ ...ctx.s }, { month: '2026-12', statementThrough: null, total: 7.3 }, 'a new month starts from the ledger');
});

test('daily-credited interest compounds: principal includes interest credited since the verified balance', () => {
  const balances = [bal('2026-11-09T19:48:00Z', 47882)];          // 10 Nov 01:18 IST, already includes 9 Nov interest
  const ledger = [{ id: 'x', accrual_date: '2026-11-10', revision: 1, interest_amount: 7.21509589, calculation_status: 'estimated' }];
  const plan = planAccrual({ kind: 'savings', balances, rates: [rate('r', 0.055, '2026-10-07')], ledger, through: '2026-11-12', dailyCredit: true });
  const p11 = 47882 + 7.22, i11 = round8(p11 * 0.055 / 365), p12 = round2(p11 + round2(i11));
  assert.deepEqual(plan.rows.map(r => [r.accrual_date, r.principal]), [['2026-11-11', p11], ['2026-11-12', p12]]);
  const est = estimatedBalance({ balances, dayTotals: plan.dayTotals, through: '2026-11-12' });
  assert.equal(est.balance, round2(47882 + 7.22 + round2(i11) + round2(plan.rows[1].interest_amount)));
  assert.equal(est.asOf, '2026-11-12T18:29:59.000Z', 'end of 12 Nov IST');
  const plain = planAccrual({ kind: 'savings', balances, rates: [rate('r', 0.055, '2026-10-07')], ledger, through: '2026-11-11' });
  assert.equal(plain.rows[0].principal, 47882, 'without daily credit the principal is the verified balance');
  assert.equal(estimatedBalance({ balances: [bal('2026-11-12T19:00:00Z', 1)], dayTotals: plan.dayTotals, through: '2026-11-12' }), null, 'a newer verified balance wins');
});

test('nightly run raises a daily-credited balance as "estimated" (v2) / "stale" (v1); a verified balance takes over again', async () => {
  const { a, uid, sav } = await interestFixture();
  await a.query(`UPDATE wealth_interest_products SET credit_frequency='daily' WHERE product_key='slice-savings'`);
  await a.query(`UPDATE wealth_accounts SET current_balance=47882, balance_as_of='2026-11-09T19:48:00Z', balance_status='verified' WHERE id=$1`, [sav]);
  const r = await runAccrual(uid, { db: a, now: NOW });
  const e = r.accounts.find(x => x.accountKey === 'slice-savings-3731').estimatedBalance;
  assert.deepEqual([e.balance, e.credited, e.stored], [47889.22, 7.22, true]);
  const [latest] = await a.query(`SELECT balance::float8 b, status FROM wealth_v_latest_balances WHERE account_id=$1`, [sav]);
  assert.deepEqual(latest, { b: 47889.22, status: 'estimated' });
  const [legacy] = await a.query(`SELECT current_balance::float8 b, balance_status s FROM wealth_accounts WHERE id=$1`, [sav]);
  assert.deepEqual(legacy, { b: 47889.22, s: 'stale' });
  await runAccrual(uid, { db: a, now: NOW });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_account_balances WHERE account_id=$1`, [sav]))[0].n, 2, 're-run adds nothing');
  await recordBalance(uid, { accountId: sav, balance: 47890, asOf: '2026-11-11T04:00:00Z', status: 'verified' }, { db: a, now: NOW });
  const [after] = await a.query(`SELECT current_balance::float8 b, balance_status s FROM wealth_accounts WHERE id=$1`, [sav]);
  assert.deepEqual(after, { b: 47890, s: 'verified' });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_account_balances WHERE status='estimated'`))[0].n, 1, 'estimate kept in history');
});

test('Bank balances menu shows the live account balances and its total equals the dashboard CASA figure', async () => {
  const vm = await import('node:vm');
  const { v1Totals } = await import('../../api/_reconcile.js');
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const fn = name => { const s = src.indexOf('function ' + name + '('); let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };
  const acc = (bank, name, bal, status, type = 'savings') => ({ bank_name: bank, account_name: name, account_type: type, currency: 'INR', current_balance: bal, balance_status: status, balance_as_of: '2026-11-10T18:29:59Z' });
  const accounts = [acc('Slice', 'Slice Savings', '47889.22', 'stale'), acc('Atom', 'Atom Savings', '63429.56', 'stale'), acc('Bank of India', 'BOI Savings', '1426.99', 'verified'),
    acc('HDFC Bank', 'HDFC Savings', '3.89', 'verified'), acc('Roarbank', 'Roarbank Savings', '650.65', 'verified'), acc('X Bank', 'Old', '500', 'unknown'), acc('Slice', 'Card', '100', 'verified', 'credit_card')];
  const ctx = { accounts, esc: s => String(s), money: v => 'INR ' + v.toFixed(2), Number, String, Date };
  vm.runInNewContext(['liveBankAccounts', 'bankCounted', 'bankStatusLabel', 'bankAsOf', 'liveBankCardsHtml', 'liveBankDetailHtml'].map(fn).join('\n') +
    ";globalThis.html=liveBankCardsHtml();globalThis.detail=liveBankDetailHtml('Slice');", ctx);
  const casa = v1Totals(accounts, []).casa;
  assert.equal(casa, 113400.31);
  assert.match(ctx.html, /<span class="pill">INR 113400\.31<\/span>/, 'menu total = dashboard CASA');
  assert.equal((ctx.html.match(/bank-balance-card/g) || []).length, 6, 'one card per bank account (not the credit card)');
  assert.match(ctx.html, /Estimated · last verified \+ interest/);
  assert.match(ctx.html, /X Bank[\s\S]*Not counted in the dashboard total/);
  assert.match(ctx.detail, /Slice Savings[\s\S]*INR 47889\.22/);
});
