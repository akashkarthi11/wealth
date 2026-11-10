import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, applyMigrations } from '../db/migrations-lib.mjs';
import { freshDb, MIGRATIONS_DIR } from './helpers/pglite.mjs';

const quiet = { log: () => {} };
const tmpMigrations = files => {
  const dir = mkdtempSync(join(tmpdir(), 'wealth-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

test('all migrations build an empty database, and a second run changes nothing (TR-0.3, TR-2.3)', async () => {
  const { a } = await freshDb();
  const migrations = loadMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 2);
  const first = await applyMigrations(a, migrations, quiet);
  assert.deepEqual(first.applied, migrations.map(m => m.id));
  const second = await applyMigrations(a, migrations, quiet);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, migrations.length);

  const tables = (await a.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).map(r => r.table_name);
  for (const t of ['wealth_users', 'wealth_accounts', 'wealth_transactions', 'wealth_positions', 'wealth_snapshots', 'wealth_schema_migrations'])
    assert.ok(tables.includes(t), `${t} should exist`);
  const sv = await a.query(`SELECT column_default FROM information_schema.columns WHERE table_name='wealth_users' AND column_name='session_version'`);
  assert.equal(sv.length, 1);
});

test('the baseline is idempotent on a database that already has the schema', async () => {
  const { a } = await freshDb();
  const baseline = readFileSync(join(MIGRATIONS_DIR, '0000_baseline.sql'), 'utf8');
  await a.exec(baseline);
  await a.exec(baseline);
});

test('an edited, already-applied migration stops the run', async () => {
  const { a } = await freshDb();
  const dir = tmpMigrations({ '0000_a.sql': 'CREATE TABLE t1 (id int);' });
  await applyMigrations(a, loadMigrations(dir), quiet);
  writeFileSync(join(dir, '0000_a.sql'), 'CREATE TABLE t1 (id int, x int);');
  await assert.rejects(applyMigrations(a, loadMigrations(dir), quiet), /checksum mismatch/);
});

test('a failing migration is rolled back and not recorded', async () => {
  const { a } = await freshDb();
  const dir = tmpMigrations({
    '0000_ok.sql': 'CREATE TABLE ok_table (id int);',
    '0001_bad.sql': 'CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;',
  });
  await assert.rejects(applyMigrations(a, loadMigrations(dir), quiet), /0001_bad failed and was rolled back/);
  const tables = (await a.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).map(r => r.table_name);
  assert.ok(tables.includes('ok_table'));
  assert.ok(!tables.includes('half_done'), 'partial work of the failed file must be rolled back');
  const ids = (await a.query('SELECT id FROM wealth_schema_migrations')).map(r => r.id);
  assert.deepEqual(ids, ['0000_ok']);
});

test('migration files may not manage their own transaction', () => {
  const dir = tmpMigrations({ '0000_tx.sql': 'BEGIN;\nCREATE TABLE x (id int);\nCOMMIT;\n' });
  assert.throws(() => loadMigrations(dir), /must not contain BEGIN/);
});

test('duplicate migration numbers are rejected', () => {
  const dir = tmpMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations(dir), /Duplicate migration number 0001/);
});

test('dry run lists pending migrations without applying them', async () => {
  const { a } = await freshDb();
  const dir = tmpMigrations({ '0000_a.sql': 'CREATE TABLE t_dry (id int);' });
  const r = await applyMigrations(a, loadMigrations(dir), { ...quiet, dryRun: true });
  assert.deepEqual(r.applied, ['0000_a']);
  const exists = await a.query(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('t_dry','wealth_schema_migrations')`);
  assert.equal(exists.length, 0, 'a dry run must not create anything');
});
