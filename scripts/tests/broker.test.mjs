// Broker funds ledger (0011, 2026-11-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { ledgerKind, parseLedgerSheet, importBrokerLedger, matchBrokerFunds, brokerSummary } from '../../api/_broker.js';

const sheet = (entries, { credit, debit, closing } = {}) => {
  const c = credit ?? entries.reduce((n, e) => n + (+e[5] || 0), 0), d = debit ?? entries.reduce((n, e) => n + (+e[4] || 0), 0);
  return [['Client Basic Information'], ['StartDate', '2021-11-05'], ['EndDate', '2026-11-11'],
    ['Opening Balance', '0', 'Closing Balance', String(closing ?? Math.round((c - d) * 100) / 100)], ['Total Credit', String(Math.round(c * 100) / 100)], ['Total Debit', String(Math.round(d * 100) / 100)],
    ['Transaction Details'], ['Transaction', 'Date', 'Segment', 'Voucher', 'Debit', 'Credit', 'Running Balance'], ...entries, ['Msg', 'Ledger Statement']];
};
const BROKING = [
  ['Funds Added', '2022-04-02 00:00:00', 'nsecm', 'V1', '', '5000', '5000'],
  ['Trades Executed', '2022-04-04 00:00:00', 'nsecm', 'V2', '4000', '', '1000'],
  ['DP Charges', '2022-04-23 00:00:00', 'nsecm', 'V3', '23.6', '', '976.4'],
  ['Reversed DP Charges', '2024-04-13 00:00:00', 'nsecm', 'V4', '', '23.6', '1000'],
  ['Funds Withdrawn', '2024-05-01 00:00:00', 'nsecm', 'V5', '900', '', '100'],
  ['Quarterly Settlement', '2024-06-25 00:00:00', 'nsecm', 'V6', '96.19', '', '3.81'],
  ['Credited for Cashback offer', '2025-01-01 00:00:00', 'nsecm', 'V7', '', '50', '53.81'],
  ['MTF interest charges', '2025-05-01 00:00:00', 'MTF', 'V8', '7.42', '', '46.39'],
  ['Quarterly Account Maintenance Charge', '2026-10-09 00:00:00', 'nsecm', 'V9', '70.8', '', '-24.41'],
  ['Funds Added', '2026-11-03 00:00:00', 'nsecm', 'V10', '', '7100', '7075.59'],
  ['Funds Added', '2026-11-03 00:00:00', 'nsecm', 'V11', '', '2000', '9075.59'],
  ['Trades Executed', '2026-11-03 00:00:00', 'nsecm', 'V12', '9079.40', '', '-3.81'],
];
const MTF = [['MTF Buy', '2025-12-04 00:00:00', 'MTF', 'M1', '911.51', '', '-911.51'], ['MTF Position Closure', '2025-12-05 00:00:00', 'MTF', 'M2', '', '911.51', '0']];

test('entry kinds follow the broker wording', () => {
  assert.equal(ledgerKind('Funds Added'), 'funds_added');
  assert.equal(ledgerKind('Funds Withdrawn'), 'funds_withdrawn');
  assert.equal(ledgerKind('Quarterly Settlement'), 'funds_withdrawn');
  assert.equal(ledgerKind('Trades Executed'), 'trade');
  assert.equal(ledgerKind('MTF Position Closure'), 'trade');
  assert.equal(ledgerKind('Cash to MTF'), 'mtf_transfer');
  assert.equal(ledgerKind('DP Charges'), 'charge');
  assert.equal(ledgerKind('Brokerage Reversal for 30 days Offer'), 'charge');
  assert.equal(ledgerKind('MTF interest charges'), 'charge');
  assert.equal(ledgerKind('Credited for scratch card offer', { credit: 15 }), 'credit_other');
});

test('a sheet must add up to its printed totals', () => {
  const ok = parseLedgerSheet(sheet(BROKING), 'broking');
  assert.equal(ok.entries.length, 12); assert.equal(ok.totals.closing, -3.81);
  assert.equal(ok.period.from, '2021-11-05');
  assert.throws(() => parseLedgerSheet(sheet(BROKING, { credit: 1 }), 'broking'), /do not match the printed totals/);
  assert.throws(() => parseLedgerSheet(sheet(BROKING, { closing: 5 }), 'broking'), /closing balance/);
});

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const tx = (d, amount, category, description = 'Angel One Securities', kind = 'investment') => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,occurred_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [u.id, kind, category, description, amount, d]).then(r => r[0].id);
  return { a, uid: u.id, tx };
}

test('import is idempotent; funds added link to the bank transfers; summary', async () => {
  const { a, uid, tx } = await setup();
  const t1 = await tx('2026-11-03', 7100, 'Investment transfer — classification pending');
  const t2 = await tx('2026-11-04', 2000, 'Investments');
  await tx('2026-11-03', 7100, 'Investment transfer', 'Some other fund');          // wrong name: never matched
  const entries = [...parseLedgerSheet(sheet(BROKING), 'broking').entries, ...parseLedgerSheet(sheet(MTF), 'mtf').entries];
  const r1 = await importBrokerLedger(uid, { broker: 'angel_one', source: 'test', entries }, { db: a });
  assert.deepEqual(r1, { inserted: 14, existing: 0 });
  const dry = await importBrokerLedger(uid, { broker: 'angel_one', source: 'test', entries }, { db: a, dryRun: true });
  assert.equal(dry.inserted, 0);
  assert.deepEqual(await importBrokerLedger(uid, { broker: 'angel_one', source: 'test 2', entries }, { db: a }), { inserted: 0, existing: 14 });

  const m = await matchBrokerFunds(uid, { db: a });
  assert.equal(m.matched.length, 2);
  assert.deepEqual(m.matched.map(x => x.transactionId).sort(), [t1, t2].sort());
  const cats = Object.fromEntries((await a.query(`SELECT id, category FROM wealth_transactions WHERE id = ANY($1)`, [[t1, t2]])).map(r => [r.id, r.category]));
  assert.equal(cats[t1], 'Funds added to Angel One', 'pending category made clear');
  assert.equal(cats[t2], 'Investments', 'an owner-set category is left alone');
  assert.equal((await matchBrokerFunds(uid, { db: a })).matched.length, 0, 'second run matches nothing new');
  const audit = await a.query(`SELECT actor, after FROM wealth_audit_log WHERE table_name='wealth_transactions' AND action='update'`);
  assert.equal(audit.length, 1); assert.equal(audit[0].actor, 'owner'); assert.deepEqual(Object.keys(audit[0].after), ['category']);

  const [s] = await brokerSummary(uid, a);
  assert.equal(s.added, 14100); assert.equal(s.withdrawn, 996.19); assert.equal(s.netPutIn, 13103.81);
  assert.equal(s.charges, 23.6 - 23.6 + 7.42 + 70.8); assert.equal(s.cash, -3.81);
  assert.equal(s.mtfBalance, 0); assert.equal(s.mtfLast, '2025-12-05'); assert.equal(s.matchedTransfers, 2);
  assert.deepEqual(s.years.map(y => y.year), [2022, 2024, 2025, 2026]);
  assert.equal(s.years.find(y => y.year === 2026).added, 9100);
});

test('no ledger yet → empty summary', async () => {
  const { a, uid } = await setup();
  assert.deepEqual(await brokerSummary(uid, a), []);
});

import { parsePnlSheet, pnlSourceKey } from '../../api/_broker.js';
test('P&L report: parsed, checked against its summary, no personal fields kept', () => {
  const head = ['Scrip Symbol', 'Company Name', 'Quantity', 'Avg Buy Price', 'Buy Value', 'Avg Sell Price', 'Sell Value', 'Gross PnL', 'Brokerage', 'Net PnL'];
  const rows = [['Client Name', 'SOMEONE'], ['PAN', '******379N'], ['From Date', '01/10/2023'], ['To Date', '10/11/2026'],
    ['Total Gross PnL', '100'], ['Total Brokerage', '5'], ['Net PnL', '85'], ['Intraday Net PnL', '-10'],
    ['Delivery PnL'], head, ['VEDL', 'VEDL', '2', '10', '20', '60', '120', '100', '5', '95'], ['Total', '', '', '', '20', '', '120', '100', '5', '95'],
    ['Intraday PnL'], head, ['HAL', 'HAL', '1', '10', '10', '0', '0', '-10', '0', '-10'], ['Total'], ['Disclaimer', 'x']];
  const p = parsePnlSheet(rows);
  assert.equal(pnlSourceKey(p), 'angelone-pnl-2023-10-01..2026-11-10');
  assert.equal(p.summary.deliveryNet, 95); assert.equal(p.delivery.length, 1); assert.equal(p.intraday.length, 1);
  assert.doesNotMatch(JSON.stringify(p), /SOMEONE|379N/);
  rows[10][9] = '90';
  assert.throws(() => parsePnlSheet(rows), /do not match/);
});
