// Import an Angel One ledger statement (.xlsx: "Broking Ledger" and "MTF Ledger" sheets) into wealth_broker_ledger,
// then link "funds added" entries to the bank-side transactions.
//
//   Check only (default, writes nothing):  node scripts/db/import-broker-ledger.mjs <env-file> <statement.xlsx>
//   Apply (owner approval required):       node scripts/db/import-broker-ledger.mjs <env-file> <statement.xlsx> --apply --yes
//
// Re-running with a newer statement adds only new entries. Nothing is deleted. The connection string is never printed.
import { readFileSync } from 'node:fs';
import { readXlsx } from './xlsx-lib.mjs';

const [envFile, file, ...flags] = process.argv.slice(2);
if (!envFile || !file) { console.error('usage: node scripts/db/import-broker-ledger.mjs <env-file> <statement.xlsx> [--apply --yes]'); process.exit(2); }
const apply = flags.includes('--apply');
if (apply && !flags.includes('--yes')) { console.error('--apply needs --yes'); process.exit(2); }
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const url = process.env.WEALTH_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) { console.error('No database URL in ' + envFile); process.exit(1); }
const host = new URL(url).host.replace(/^([^.]{6})[^.]*/, '$1…');

const { sql, ownerId } = await import('../../api/_lib.js');
const { parseLedgerSheet, importBrokerLedger, matchBrokerFunds, brokerSummary } = await import('../../api/_broker.js');

const book = readXlsx(file);
const sheet = name => { const k = Object.keys(book).find(n => n.trim().toLowerCase() === name); if (!k) throw new Error(`sheet "${name}" not found (have: ${Object.keys(book).join(', ')})`); return book[k]; };
const broking = parseLedgerSheet(sheet('broking ledger'), 'broking');
const mtf = parseLedgerSheet(sheet('mtf ledger'), 'mtf');
const source = `Angel One ledger ${broking.period.from}..${broking.period.to}`;
console.log(`${apply ? 'APPLY' : 'check only'} on ${host} · ${source}`);
console.log(`broking: ${broking.entries.length} entries, closing ${broking.totals.closing} · mtf: ${mtf.entries.length} entries, closing ${mtf.totals.closing} (totals verified)`);

const uid = await ownerId(sql);
const [acct] = await sql.query(`SELECT id FROM wealth_accounts WHERE user_id=$1 AND bank_name='Angel One' AND account_type='demat_equity' LIMIT 1`, [uid]);
const opts = { db: sql, dryRun: !apply };
const r = await importBrokerLedger(uid, { broker: 'angel_one', accountId: acct?.id || null, source, entries: [...broking.entries, ...mtf.entries] }, opts);
console.log(`entries: ${r.inserted} new, ${r.existing} already stored`);
if (apply) {
  const m = await matchBrokerFunds(uid, { db: sql });
  console.log(`funds added matched to bank transactions: ${m.matched.length}` + m.matched.map(x => `\n  ${x.date} ₹${x.amount}${x.recategorise ? ' (category → Funds added to Angel One)' : ''}`).join('') + `\n  not matched (since the first bank transaction): ${m.unmatched}`);
  const [s] = await brokerSummary(uid, sql);
  if (s) console.log(`summary: added ₹${s.added} · withdrawn ₹${s.withdrawn} · net put in ₹${s.netPutIn} · charges ₹${s.charges} (this year ₹${s.chargesThisYear}) · cash ₹${s.cash} · MTF ₹${s.mtfBalance} (last ${s.mtfLast})`);
} else {
  console.log('nothing written; add --apply --yes after approval');
}
