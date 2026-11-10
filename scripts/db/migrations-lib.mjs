// Versioned migration runner core (TSD Phase 2, TR-2.1 to TR-2.3).
// Each scripts/migrations/NNNN_name.sql file is applied exactly once, inside one transaction,
// and recorded in wealth_schema_migrations with its SHA-256 checksum. A changed checksum stops the run.
// Works with any adapter exposing exec(text) for multi-statement SQL and query(text, params) -> rows.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TOP_LEVEL_TX = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*$/im;
const LOCK_KEY = 727274001; // pg advisory lock: one migration run at a time

export function loadMigrations(dir) {
  const files = readdirSync(dir).filter(f => MIGRATION_FILE.test(f)).sort();
  const seen = new Set();
  return files.map(file => {
    const id = file.replace(/\.sql$/, '');
    const number = file.slice(0, 4);
    if (seen.has(number)) throw new Error(`Duplicate migration number ${number}`);
    seen.add(number);
    const sql = readFileSync(join(dir, file), 'utf8');
    if (TOP_LEVEL_TX.test(sql)) throw new Error(`${file} must not contain BEGIN/COMMIT/ROLLBACK; the runner wraps each file in a transaction`);
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    return { id, file, sql, checksum };
  });
}

export async function applyMigrations(db, migrations, { log = console.log, dryRun = false } = {}) {
  const tracked = (await db.query(`SELECT to_regclass('public.wealth_schema_migrations') IS NOT NULL AS ok`))[0].ok;
  if (!tracked && !dryRun) await db.exec(`CREATE TABLE IF NOT EXISTS wealth_schema_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  const applied = [], skipped = [];
  try {
    const done = new Map(tracked || !dryRun
      ? (await db.query('SELECT id, checksum FROM wealth_schema_migrations')).map(r => [r.id, r.checksum])
      : []);
    for (const m of migrations) {
      if (done.has(m.id)) {
        if (done.get(m.id) !== m.checksum) throw new Error(`Migration ${m.id} was changed after it was applied (checksum mismatch). Add a new migration instead of editing an applied one.`);
        skipped.push(m.id);
        continue;
      }
      if (dryRun) { log(`[db-migrate] pending: ${m.id}`); applied.push(m.id); continue; }
      await db.exec('BEGIN');
      try {
        await db.exec(m.sql);
        await db.query('INSERT INTO wealth_schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, m.checksum]);
        await db.exec('COMMIT');
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${m.id} failed and was rolled back: ${e.message}`);
      }
      log(`[db-migrate] applied ${m.id}`);
      applied.push(m.id);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
  return { applied, skipped };
}
