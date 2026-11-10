// Copy all public.wealth_* tables from one database to another (e.g. production -> development).
//
//   Dry run (default; reads both, changes nothing):
//     node scripts/db/copy-db.mjs <source-env-file> <target-env-file>
//   Apply (backs up the target to JSON first, then replaces its rows in one transaction):
//     node scripts/db/copy-db.mjs <source-env-file> <target-env-file> --apply --yes [--backup-dir .db-backups] [--empty-target-only]
//   --empty-target-only also empties wealth_* tables that exist only in the target (needed when they reference copied tables).
//
// The source is read in a READ ONLY, REPEATABLE READ transaction. Connection strings are never printed.
// Refuses to write to a target whose env file says VERCEL_ENV=production, or to the source's own host.
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, plan, count, copyAll, backup } from './copy-lib.mjs';

const args = process.argv.slice(2);
const [srcFile, dstFile] = args.filter(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const backupDir = args.includes('--backup-dir') ? args[args.indexOf('--backup-dir') + 1] : '.db-backups';
if (!srcFile || !dstFile) { console.error('usage: node scripts/db/copy-db.mjs <source-env> <target-env> [--apply --yes]'); process.exit(2); }

const loadEnv = f => Object.fromEntries(readFileSync(f, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]));
const srcEnv = loadEnv(srcFile), dstEnv = loadEnv(dstFile);
const urlOf = (env, f) => {
  const u = env.POSTGRES_URL || env.WEALTH_DATABASE_URL || env.DATABASE_URL;
  if (!u) { console.error('No database URL in ' + f); process.exit(1); }
  return u;
};
const srcUrl = urlOf(srcEnv, srcFile), dstUrl = urlOf(dstEnv, dstFile);
const hostOf = u => new URL(u).host.replace('-pooler', '');
const label = u => hostOf(u).replace(/^([^.]{6})[^.]*/, '$1…');
const sameHost = hostOf(srcUrl) === hostOf(dstUrl);

if (apply) {
  if (!args.includes('--yes')) { console.error(`Refusing to overwrite ${label(dstUrl)} without --yes.`); process.exit(2); }
  if (sameHost) { console.error('Source and target are the same database; refusing.'); process.exit(2); }
  if (dstEnv.VERCEL_ENV === 'production') { console.error(`${dstFile} is a production env file; refusing to write to it.`); process.exit(2); }
}

if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
const srcPool = new Pool({ connectionString: srcUrl }), dstPool = new Pool({ connectionString: dstUrl });
const source = await srcPool.connect(), target = await dstPool.connect();

try {
  await source.query('begin isolation level repeatable read read only');
  const [srcT, dstT] = [await describe(source), await describe(target)];
  const p = plan(srcT, dstT);
  console.log(`source ${label(srcUrl)} (${srcFile})  ->  target ${label(dstUrl)} (${dstFile})${sameHost ? '  [SAME DATABASE]' : ''}`);
  const rows = [];
  for (const name of [...new Set([...srcT.keys(), ...dstT.keys()])].sort()) {
    rows.push({ table: name,
      source: srcT.has(name) ? await count(source, name) : '-',
      target: dstT.has(name) ? await count(target, name) : '-' });
  }
  console.table(rows);
  p.warnings.forEach(w => console.log('warning: ' + w));
  p.errors.forEach(e => console.log('ERROR:   ' + e));
  if (p.errors.length) { process.exitCode = 1; }
  else if (!apply) {
    console.log(`\nDry run: ${p.copy.length} table(s) would be replaced, in order: ${p.copy.map(t => t.name).join(', ')}`);
    console.log('Re-run with --apply --yes to do it.');
  } else {
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `target-${hostOf(dstUrl).split('.')[0]}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, await backup(target, p.copy));
    console.log(`\nBacked up current target rows to ${file}`);
    const empty = args.includes('--empty-target-only') ? p.extra : [];
    if (empty.length) {
      const extraDesc = new Map([...dstT].filter(([n]) => empty.includes(n)));
      writeFileSync(file.replace(/\.json$/, '-target-only.json'), await backup(target, [...extraDesc.values()]));
      console.log(`Also emptying target-only table(s): ${empty.join(', ')} (backed up alongside)`);
    }
    await copyAll(source, target, p.copy, (t, n) => console.log(`  copied ${t}: ${n}`), empty);
    console.log('-- done; target now matches source for all copied tables');
  }
} catch (e) {
  console.error('-- failed (target rolled back):', e.message);
  process.exitCode = 1;
} finally {
  await source.query('rollback').catch(() => {});
  source.release(); target.release();
  await srcPool.end(); await dstPool.end();
}
