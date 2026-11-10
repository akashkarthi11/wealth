// Deploy-time schema migrations (TSD Phase 2).
// Applies each scripts/migrations/NNNN_*.sql exactly once, in order, each in its own transaction,
// recording it in wealth_schema_migrations. Data repairs are NOT run here: they live in
// scripts/db/repairs/ and are run manually with owner approval.
//
//   node scripts/migrate-db.mjs              (Vercel build; Production only)
//   node scripts/migrate-db.mjs --dry-run    (list pending migrations, change nothing)
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { fileURLToPath } from 'node:url';
import { loadMigrations, applyMigrations } from './db/migrations-lib.mjs';

const dryRun = process.argv.includes('--dry-run');
if (process.env.VERCEL && process.env.VERCEL_ENV !== 'production') {
  console.log('[db-migrate] Preview deployment; migrations skipped.');
  process.exit(0);
}
const databaseUrl = process.env.POSTGRES_URL || process.env.WEALTH_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  if (process.env.VERCEL) throw new Error('Database URL is required to run production schema migrations');
  console.log('[db-migrate] No database URL; skipped outside Vercel.');
  process.exit(0);
}

if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
const adapter = {
  exec: text => client.query(text),
  query: async (text, params) => (await client.query(text, params)).rows,
};

try {
  const migrations = loadMigrations(fileURLToPath(new URL('./migrations/', import.meta.url)));
  const { applied, skipped } = await applyMigrations(adapter, migrations, { dryRun });
  console.log(`[db-migrate] ${dryRun ? 'pending' : 'applied'}: ${applied.length}, already applied: ${skipped.length}`);
} catch (error) {
  console.error('[db-migrate] Failed:', error?.message || error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
