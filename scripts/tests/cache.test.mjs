// Versioned Redis cache (migration 0018, 2026-11-11): every write — app, cron or external SQL — bumps one data version;
// cached responses are served only while the version is unchanged. Also: the cached routes use the helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';

const version = async a => Number((await a.query('SELECT version FROM wealth_data_version WHERE id=1'))[0].version);

test('any write to a data table bumps the version once per statement; reads do not', async () => {
  const { a } = await migratedDb();
  const v0 = await version(a);
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const v1 = await version(a); assert.equal(v1, v0 + 1);
  await a.query(`SELECT * FROM wealth_transactions`); assert.equal(await version(a), v1, 'a read changes nothing');
  // one multi-row INSERT = one bump (bulk imports stay cheap)
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,occurred_on)
    SELECT $1,'expense','Food','x',10,'',d FROM generate_series('2026-11-01'::date,'2026-11-05'::date,'1 day') d`, [u.id]);
  const v2 = await version(a); assert.equal(v2, v1 + 1);
  // an external writer (no wealth.actor) on another table also bumps
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'k','B','N','savings','savings','INR')`, [u.id]);
  assert.ok(await version(a) > v2);
  // an UPDATE that touches no rows still counts as a write statement — harmless, it only forces a rebuild
  const v3 = await version(a);
  await a.query(`UPDATE wealth_transactions SET amount = amount WHERE false`);
  assert.equal(await version(a), v3 + 1);
});

test('log and bookkeeping tables do not bump the version', async () => {
  const { a } = await migratedDb();
  const v0 = await version(a);
  await a.query(`INSERT INTO wealth_job_runs(job,status) VALUES('price-refresh','succeeded')`).catch(() => {});
  await a.query(`INSERT INTO wealth_sync_issues(source_table,source_id,message) VALUES('t','1','m')`).catch(() => {});
  assert.equal(await version(a), v0);
});

test('routes use the versioned cache and send X-Wealth-Cache', () => {
  const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  assert.match(read('api/_routes/dashboard.js'), /cachedForUser\(req,'dashboard',/);
  assert.match(read('api/_routes/ledger.js'), /cachedForUser\(req,'ledger',uid=>pageTransactions\(uid\),\{ttl:600\}\)/);
  assert.match(read('api/_routes/snapshot.js'), /cachedForUser\(req,'snapshots',/);
  assert.match(read('api/_routes/account-detail.js'), /cachedForUser\(req, 'account-detail',/);
  assert.match(read('api/_routes/rewards.js'), /cachedValue\(who\.uid, 'rewards',/);
  assert.match(read('api/_routes/interest.js'), /cachedValue\(who\.uid, 'interest',/);
  const lib = read('api/_lib.js');
  assert.match(lib, /SELECT u\.session_version,\(SELECT version FROM wealth_data_version WHERE id=1\) AS data_version FROM wealth_users u WHERE u\.id=\$1/, 'session check and version in one query');
  assert.match(lib, /Promise\.all\(\[sessionAndVersion\(req\),cacheGet\(key\)\]\)/, 'Redis read in parallel with the database');
  assert.match(lib, /if\(c&&c\.v===who\.version\)return/, 'served only when the version matches');
  assert.match(lib, /waitUntil\(cacheSet\(key,\{v:who\.version,d:data\},ttl\)/, 'cache write after the response');
});
