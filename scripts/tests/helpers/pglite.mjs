// In-memory PostgreSQL (PGlite) for migration and SQL tests. No network, no real database touched.
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { loadMigrations, applyMigrations } from '../../db/migrations-lib.mjs';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function adapter(db) {
  return {
    exec: text => db.exec(text),
    query: async (text, params = []) => (await db.query(text, params)).rows,
  };
}

export async function freshDb() {
  const db = new PGlite();
  return { db, a: adapter(db) };
}

export async function migratedDb() {
  const { db, a } = await freshDb();
  await applyMigrations(a, loadMigrations(MIGRATIONS_DIR), { log: () => {} });
  return { db, a };
}
