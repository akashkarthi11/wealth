// Full data backup of a database to JSON, read-only.
//
//   node scripts/db/backup-db.mjs <env-file> [out-dir]      (out-dir defaults to .db-backups/<host>-<timestamp>)
//
// Every base table in every non-system schema is written to <schema>.<table>.json as a JSON array of rows,
// exported as JSON text by Postgres (numerics keep full precision). All reads happen in one
// REPEATABLE READ READ ONLY transaction, so the backup is a consistent snapshot. Also writes
// manifest.json (row counts, sequence values). The connection string is never printed.
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

const [envFile, outArg] = process.argv.slice(2);
if (!envFile) { console.error('usage: node scripts/db/backup-db.mjs <env-file> [out-dir]'); process.exit(2); }
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]));
const url = env.POSTGRES_URL || env.WEALTH_DATABASE_URL || env.DATABASE_URL;
if (!url || !/^postgres/.test(url)) { console.error('No usable database URL in ' + envFile); process.exit(1); }
const host = new URL(url).host.replace('-pooler', '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = outArg || join('.db-backups', `${host.split('.')[0]}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const ident = n => '"' + String(n).replace(/"/g, '""') + '"';
if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: url });
const db = await pool.connect();
const manifest = { host: host.replace(/^([^.]{6})[^.]*/, '$1…'), envFile, takenAt: new Date().toISOString(), tables: {}, sequences: {} };

try {
  await db.query('begin isolation level repeatable read read only');
  manifest.server = (await db.query('select version() v, current_database() d')).rows[0];
  const { rows: tables } = await db.query(
    `select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_%'
      order by 1, 2`);
  for (const { s, t } of tables) {
    const q = `${ident(s)}.${ident(t)}`, file = join(outDir, `${s}.${t}.json`);
    const out = createWriteStream(file); out.write('[');
    let n = 0;
    for (let off = 0, chunk = 2000; ; off += chunk) {
      const { rows } = await db.query(
        `select coalesce(string_agg(to_json(x)::text, ','), '') j, count(*)::int n
           from (select * from ${q} order by ctid limit $1 offset $2) x`, [chunk, off]);
      if (rows[0].n) { if (n) out.write(','); out.write(rows[0].j); }
      n += rows[0].n;
      if (rows[0].n < chunk) break;
    }
    out.end(']\n'); await once(out, 'finish');
    const expected = (await db.query(`select count(*)::int n from ${q}`)).rows[0].n;
    if (expected !== n) throw new Error(`${s}.${t}: wrote ${n} rows, table has ${expected}`);
    manifest.tables[`${s}.${t}`] = n;
    console.log(`  ${s}.${t}: ${n}`);
  }
  const { rows: seqs } = await db.query(`select schemaname s, sequencename q, last_value from pg_sequences
    where schemaname not in ('pg_catalog','information_schema') order by 1, 2`);
  for (const r of seqs) manifest.sequences[`${r.s}.${r.q}`] = r.last_value;
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`-- backup complete: ${tables.length} tables, ${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows -> ${outDir}`);
} catch (e) {
  console.error('-- backup FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await db.query('rollback').catch(() => {});
  db.release(); await pool.end();
}
