import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDestructiveSql, loadMigrations } from '../db/migrations-lib.mjs';
import { MIGRATIONS_DIR } from './helpers/pglite.mjs';

const REPAIRS_DIR = fileURLToPath(new URL('../db/repairs/', import.meta.url));

test('the guard flags statements that delete data', () => {
  for (const sql of [
    'DELETE FROM wealth_transactions WHERE id = 1;',
    'delete   from wealth_snapshots;',
    'TRUNCATE wealth_positions;',
    'DROP TABLE wealth_positions;',
    'DROP VIEW wealth_v_latest_prices;',
    'ALTER TABLE wealth_transactions DROP COLUMN account;',
    'ALTER TABLE wealth_transactions DROP account;',
  ]) assert.ok(findDestructiveSql(sql), sql);
});

test('the guard allows structural changes and FK delete rules', () => {
  for (const sql of [
    'DROP INDEX IF EXISTS wealth_interest_rates_lookup_idx;',
    'ALTER TABLE x DROP CONSTRAINT IF EXISTS x_fkey;',
    'DROP TRIGGER IF EXISTS t ON x;',
    'ALTER TABLE x ALTER COLUMN y DROP NOT NULL;',
    'ALTER TABLE x ALTER COLUMN y DROP DEFAULT;',
    'CREATE TABLE t (id uuid REFERENCES u(id) ON DELETE CASCADE);',
    "-- DELETE FROM in a comment\nSELECT 1;",
    "SELECT 'DELETE FROM in a string';",
  ]) assert.equal(findDestructiveSql(sql), null, sql);
});

test('every migration in the repository is non-destructive', () => {
  assert.doesNotThrow(() => loadMigrations(MIGRATIONS_DIR));
});

test('every data repair script is non-destructive', () => {
  for (const f of readdirSync(REPAIRS_DIR).filter(f => f.endsWith('.sql'))) {
    assert.equal(findDestructiveSql(readFileSync(join(REPAIRS_DIR, f), 'utf8')), null, f);
  }
});

test('the runner refuses a migration that would delete data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wealth-nodel-'));
  writeFileSync(join(dir, '0000_bad.sql'), 'DELETE FROM wealth_transactions;');
  assert.throws(() => loadMigrations(dir), /must never delete data/);
});
