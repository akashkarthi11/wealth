// Encrypted backups and restore drills (TSD Claude Plan 3, TR3-6.1). The key is read from WEALTH_BACKUP_KEY in the
// environment or from --key-env <env-file>; it is never printed. Connection strings are never printed.
//
//   node scripts/db/backup-restore.mjs backup <env-file> <out.wlb>          read-only dump of a database, encrypted
//   node scripts/db/backup-restore.mjs drill <file.wlb>                     restore into a fresh in-memory database
//                                                                           (all migrations applied) and compare counts
//   node scripts/db/backup-restore.mjs restore <file.wlb> <target-env> --apply --yes
//                                                                           replace the rows of a NON-production database
import { neon, Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encryptBackup, decryptBackup, dumpDatabase } from '../../api/_backup.js';
import { restoreAll } from './restore-lib.mjs';

const args = process.argv.slice(2), [cmd, a1, a2] = args.filter(a => !a.startsWith('--'));
const flag = n => args.includes(n), opt = n => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const loadEnv = f => Object.fromEntries(readFileSync(f, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]));
const key = () => (opt('--key-env') ? loadEnv(opt('--key-env')).WEALTH_BACKUP_KEY : process.env.WEALTH_BACKUP_KEY);
const dbUrl = env => env.POSTGRES_URL || env.WEALTH_DATABASE_URL || env.DATABASE_URL;
const short = url => new URL(url).host.replace(/^([^.]{6})[^.]*/, '$1…');
const fail = m => { console.error(m); process.exit(1); };

if (cmd === 'backup') {
  if (!a1 || !a2) fail('usage: backup <env-file> <out.wlb>');
  const url = dbUrl(loadEnv(a1)); if (!url) fail('No database URL in ' + a1);
  const q = neon(url);
  const db = { query: (t, p) => q.query(t, p), txBatch: stmts => q.transaction(stmts.map(([t, p]) => q.query(t, p)), { isolationLevel: 'RepeatableRead', readOnly: true }) };
  const dump = await dumpDatabase(db);
  writeFileSync(a2, encryptBackup(dump, key()));
  console.log(`backup of ${short(url)} → ${a2}: ${Object.keys(dump.tables).length} tables, ${Object.values(dump.manifest.counts).reduce((x, y) => x + y, 0)} rows`);
} else if (cmd === 'drill') {
  if (!a1) fail('usage: drill <file.wlb>');
  const data = decryptBackup(readFileSync(a1), key());
  const { PGlite } = await import('@electric-sql/pglite');
  const { loadMigrations, applyMigrations } = await import('./migrations-lib.mjs');
  const mem = new PGlite();
  await applyMigrations({ exec: t => mem.exec(t), query: async (t, p = []) => (await mem.query(t, p)).rows },
    loadMigrations(fileURLToPath(new URL('../migrations/', import.meta.url))), { log: () => {} });
  const counts = await restoreAll(mem, data, (t, n) => { if (n === null) console.log('drill: ' + t); }, { allowMissing: true });
  const bad = Object.entries(data.manifest.counts).filter(([t, n]) => t in counts && counts[t] !== n);
  console.log(`drill: backup taken ${data.manifest.takenAt} (${data.manifest.environment}); restored ${Object.keys(counts).length} tables, ` +
    `${Object.values(counts).reduce((x, y) => x + y, 0)} rows into a fresh migrated database; ${bad.length ? 'MISMATCH ' + JSON.stringify(bad) : 'all counts match'}`);
  if (bad.length) process.exit(1);
} else if (cmd === 'restore') {
  if (!a1 || !a2) fail('usage: restore <file.wlb> <target-env> --apply --yes');
  const env = loadEnv(a2), url = dbUrl(env);
  if (!url) fail('No database URL in ' + a2);
  if (env.VERCEL_ENV === 'production' || /production/i.test(a2)) fail('Refusing to restore into a production database.');
  const data = decryptBackup(readFileSync(a1), key());
  console.log(`restore ${data.manifest.takenAt} (${data.manifest.environment}) → ${short(url)}: ${Object.keys(data.tables).length} tables`);
  if (!(flag('--apply') && flag('--yes'))) { console.log('dry run: add --apply --yes to replace the target rows'); process.exit(0); }
  if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url }), client = await pool.connect();
  try { const counts = await restoreAll(client, data, (t, n) => console.log(`  ${t}: ${n}`)); console.log(`restored ${Object.keys(counts).length} tables`); }
  finally { client.release(); await pool.end(); }
} else fail('usage: backup | drill | restore (see the header of this file)');
