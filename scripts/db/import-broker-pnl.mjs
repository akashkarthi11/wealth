// Store an Angel One Profit & Loss report (.xlsx, "Equity P&L" sheet) as one wealth_snapshots record (kind broker_pnl).
//
//   Check only (default):            node scripts/db/import-broker-pnl.mjs <env-file> <pnl.xlsx>
//   Apply (owner approval required): node scripts/db/import-broker-pnl.mjs <env-file> <pnl.xlsx> --apply --yes
//
// One record per report period (source_key angelone-pnl-<from>..<to>); the same report again changes nothing.
// No name, PAN or client id is stored. The connection string is never printed.
import { readFileSync } from 'node:fs';
import { readXlsx } from './xlsx-lib.mjs';

const [envFile, file, ...flags] = process.argv.slice(2);
if (!envFile || !file) { console.error('usage: node scripts/db/import-broker-pnl.mjs <env-file> <pnl.xlsx> [--apply --yes]'); process.exit(2); }
const apply = flags.includes('--apply');
if (apply && !flags.includes('--yes')) { console.error('--apply needs --yes'); process.exit(2); }
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const url = process.env.WEALTH_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) { console.error('No database URL in ' + envFile); process.exit(1); }
const host = new URL(url).host.replace(/^([^.]{6})[^.]*/, '$1…');

const { sql, ownerId, withActor } = await import('../../api/_lib.js');
const { parsePnlSheet, pnlSourceKey } = await import('../../api/_broker.js');
const book = readXlsx(file);
const sheet = book[Object.keys(book).find(n => n.trim().toLowerCase() === 'equity p&l')];
if (!sheet) { console.error('sheet "Equity P&L" not found'); process.exit(1); }
const p = parsePnlSheet(sheet), key = pnlSourceKey(p);
console.log(`${apply ? 'APPLY' : 'check only'} on ${host} · ${key}`);
console.log(`delivery ${p.delivery.length} rows net ₹${p.summary.deliveryNet} · intraday ${p.intraday.length} rows net ₹${p.summary.intradayNet} · total net ₹${p.summary.net} (totals verified)`);
const uid = await ownerId(sql);
const [have] = await sql.query('SELECT id FROM wealth_snapshots WHERE user_id=$1 AND source_key=$2', [uid, key]);
if (have) { console.log('already stored; nothing to do'); process.exit(0); }
if (!apply) { console.log('nothing written; add --apply --yes after approval'); process.exit(0); }
const [r] = await withActor(sql, 'owner', [[`INSERT INTO wealth_snapshots (user_id, source_key, source_name, snapshot_date, payload)
  VALUES ($1,$2,'Angel One P&L report',$3,$4::jsonb) ON CONFLICT (user_id, source_key) DO NOTHING RETURNING id`, [uid, key, p.period.to, JSON.stringify(p)]]]);
console.log(r.length ? 'stored 1 record' : 'already stored');
