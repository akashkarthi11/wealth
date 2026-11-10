// The app must behave the same on every deployment: Production, Preview, and a separate Vercel team,
// whatever mix of database variables each one sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.WEALTH_SESSION_SECRET ||= 'x'.repeat(40);
const { firstUrl, DB_URL_VARS, configStatus } = await import('../../api/_lib.js');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const pg = 'postgresql://u:p@host.example/neondb';

test('database URL: the first real postgres URL wins; empty and placeholder values are skipped', () => {
  const pick = env => firstUrl(DB_URL_VARS, ['postgres', 'postgresql'], env)?.name ?? null;
  // Production shape: POSTGRES_URL real, DATABASE_URL hidden placeholder
  assert.equal(pick({ POSTGRES_URL: pg, DATABASE_URL: '[SENSITIVE]' }), 'POSTGRES_URL');
  // Preview shape: DATABASE_URL empty
  assert.equal(pick({ POSTGRES_URL: pg, DATABASE_URL: '' }), 'POSTGRES_URL');
  // Development-team shape: only DATABASE_URL
  assert.equal(pick({ DATABASE_URL: pg }), 'DATABASE_URL');
  // Placeholder first, real later
  assert.equal(pick({ POSTGRES_URL: '[SENSITIVE]', DATABASE_URL: `"${pg}"` }), 'DATABASE_URL');
  assert.equal(pick({ POSTGRES_URL: '', DATABASE_URL: 'not a url' }), null);
});

test('config status reports each setting as yes/no and never exposes values', () => {
  const s = configStatus({ VERCEL_ENV: 'production', POSTGRES_URL: pg, DATABASE_URL: '[SENSITIVE]', WEALTH_SESSION_SECRET: 's'.repeat(64), WEALTH_ACCESS_KEY: 'k', REDIS_URL: '[SENSITIVE]' });
  assert.deepEqual(s.database, { configured: true, variable: 'POSTGRES_URL' });
  assert.equal(s.sessionSecret, true);
  assert.equal(s.redis, 'invalid (ignored)');
  assert.equal(s.cronSecret, false);
  assert.ok(!JSON.stringify(s).includes('host.example'), 'no URL in the output');
  assert.ok(!JSON.stringify(s).includes('sss'), 'no secret in the output');
  const dev = configStatus({ VERCEL_ENV: 'preview', DATABASE_URL: pg });
  assert.equal(dev.sessionSecret, false);
  assert.equal(dev.redis, 'not set (optional)');
  assert.equal(configStatus({ WEALTH_SESSION_SECRET: '[SENSITIVE]' }).sessionSecret, false, 'a placeholder is not a secret');
});

function runMigrateDb(env) {
  return spawnSync(process.execPath, ['scripts/migrate-db.mjs', '--dry-run'], {
    cwd: repo, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
}

test('migrations are skipped on Preview builds unless the project opts in', () => {
  const skipped = runMigrateDb({ VERCEL: '1', VERCEL_ENV: 'preview', POSTGRES_URL: pg });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /Preview deployment; migrations skipped/);
});

test('a Vercel build without any real database URL fails loudly instead of skipping', () => {
  const r = runMigrateDb({ VERCEL: '1', VERCEL_ENV: 'production', DATABASE_URL: '[SENSITIVE]' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Database URL is required/);
});
