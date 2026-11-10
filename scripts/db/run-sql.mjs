// Run a SQL file against the database named in an env file.
//
//   Read-only (default): every statement runs inside a READ ONLY transaction; rows are printed.
//     node scripts/db/run-sql.mjs <env-file> <file.sql>
//   Apply (data repairs, owner approval required): the whole file runs on one connection.
//     node scripts/db/run-sql.mjs <env-file> <file.sql> --apply --yes
//
// The connection string is never printed; only a shortened host name is shown.
import { neon, Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { readFileSync } from 'node:fs';

const [envFile, sqlFile, ...flags] = process.argv.slice(2);
if (!envFile || !sqlFile) { console.error('usage: node scripts/db/run-sql.mjs <env-file> <file.sql> [--apply --yes]'); process.exit(2); }
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]));
const url = env.WEALTH_DATABASE_URL || env.POSTGRES_URL || env.DATABASE_URL;
if (!url) { console.error('No database URL in ' + envFile); process.exit(1); }
const host = new URL(url).host.replace(/^([^.]{6})[^.]*/, '$1…');
const source = readFileSync(sqlFile, 'utf8');

function splitStatements(text) {
  const out = []; let cur = '', i = 0, dollar = null, quote = false;
  while (i < text.length) {
    const ch = text[i];
    if (!dollar && !quote && ch === '-' && text[i + 1] === '-') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (!quote) { const m = text.slice(i).match(/^\$[A-Za-z_]*\$/); if (m) { if (!dollar) dollar = m[0]; else if (dollar === m[0]) dollar = null; cur += m[0]; i += m[0].length; continue; } }
    if (!dollar && ch === "'") quote = !quote;
    if (!dollar && !quote && ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

if (!flags.includes('--apply')) {
  const sql = neon(url);
  console.log(`-- read-only run on ${host}: ${sqlFile}`);
  for (const stmt of splitStatements(source)) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
    const label = stmt.replace(/\s+/g, ' ').slice(0, 100);
    try {
      const [rows] = await sql.transaction([sql.query(stmt)], { readOnly: true });
      console.log(`\n[${rows.length} row(s)] ${label}`);
      if (rows.length) console.table(rows.slice(0, 50));
    } catch (e) {
      console.log(`\n[not run] ${label}\n  -> ${e.message}`);
    }
  }
} else {
  if (!flags.includes('--yes')) { console.error(`Refusing to change ${host} without --yes. Get owner approval for this environment first.`); process.exit(2); }
  if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    console.log(`-- APPLYING ${sqlFile} on ${host}`);
    const result = await client.query(source);
    const results = Array.isArray(result) ? result : [result];
    results.forEach(r => r.command && console.log(`${r.command} ${r.rowCount ?? ''}`));
    console.log('-- done');
  } catch (e) {
    console.error('-- failed (nothing committed if the file uses BEGIN/COMMIT):', e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
