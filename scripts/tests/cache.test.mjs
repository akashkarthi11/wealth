// Versioned cache, 3 layers (2026-11-11): data version (0018) bumps on every write from any writer; responses are
// served from the browser (304), instance memory, or Redis (gzip) only while the version is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { packEntry, unpackEntry, etagFor, memGet, memSet, memStats, sendCached, withStatus, cookie } from '../../api/_lib.js';

const version = async a => Number((await a.query('SELECT version FROM wealth_data_version WHERE id=1'))[0].version);

test('any write to a data table bumps the version once per statement; reads do not', async () => {
  const { a } = await migratedDb();
  const v0 = await version(a);
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const v1 = await version(a); assert.equal(v1, v0 + 1);
  await a.query(`SELECT * FROM wealth_transactions`); assert.equal(await version(a), v1, 'a read changes nothing');
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,occurred_on)
    SELECT $1,'expense','Food','x',10,'',d FROM generate_series('2026-11-01'::date,'2026-11-05'::date,'1 day') d`, [u.id]);
  const v2 = await version(a); assert.equal(v2, v1 + 1, 'one multi-row insert = one bump');
  await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'k','B','N','savings','savings','INR')`, [u.id]);
  assert.ok(await version(a) > v2, 'an external writer on another table bumps too');
});

test('log and bookkeeping tables do not bump the version', async () => {
  const { a } = await migratedDb();
  const v0 = await version(a);
  await a.query(`INSERT INTO wealth_sync_issues(source_table,source_id,message) VALUES('t','1','m')`);
  assert.equal(await version(a), v0);
});

test('Redis entries are gzip-packed finished bodies and round-trip exactly; old plain JSON still reads', () => {
  const body = JSON.stringify({ transactions: Array.from({ length: 400 }, (_, i) => ({ id: i, description: 'Swiggy order ' + i, amount: 120 + i, kind: 'expense' })) });
  const packed = packEntry({ v: '42', s: 200, b: body });
  assert.ok(packed.startsWith('z1:'));
  assert.ok(packed.length < body.length / 4, `compressed ${packed.length} vs ${body.length} bytes`);
  assert.deepEqual(unpackEntry(packed), { v: '42', s: 200, b: body });
  assert.deepEqual(unpackEntry(JSON.stringify({ v: '1', s: 200, b: '{}' })), { v: '1', s: 200, b: '{}' });
});

test('memory layer: LRU with expiry; ETag changes with the version', () => {
  memSet('k-a', { v: '1', s: 200, b: '{"a":1}' }, 60, 1000);
  assert.equal(memGet('k-a', 2000).b, '{"a":1}');
  assert.equal(memGet('k-a', 1000 + 61000), null, 'expired');
  for (let i = 0; i < 45; i++) memSet('k-' + i, { v: '1', s: 200, b: 'x' }, 60);
  assert.ok(memStats().entries <= 40, 'capped');
  assert.notEqual(etagFor('key', '5'), etagFor('key', '6'));
  assert.match(etagFor('key', '5'), /^"w2-[A-Za-z0-9_-]{20}"$/);
});

test('sendCached: 304 without a body when the browser has the version; otherwise the stored body, private + no-cache', () => {
  const fake = () => { const h = {}; return { h, statusCode: 0, body: undefined, setHeader: (k, v) => { h[k.toLowerCase()] = v; }, end(b) { this.body = b; } }; };
  let res = fake(); sendCached(res, { notModified: true, etag: '"w2-x"', source: 'browser' });
  assert.deepEqual([res.statusCode, res.body, res.h.etag, res.h['cache-control'], res.h['x-wealth-cache']], [304, undefined, '"w2-x"', 'private, no-cache', 'browser']);
  res = fake(); sendCached(res, { status: 200, body: '{"ok":1}', etag: '"w2-y"', source: 'redis' });
  assert.deepEqual([res.statusCode, res.body, res.h['content-type'], res.h['x-wealth-cache']], [200, '{"ok":1}', 'application/json; charset=utf-8', 'redis']);
  assert.deepEqual(withStatus(404, { error: 'x' }), { __status: 404, data: { error: 'x' } });
  res = fake(); cookie(res, ''); assert.equal(res.h['clear-site-data'], undefined, 'no Clear-Site-Data: Chrome held sign-out until its cache was cleared (2026-11-11)');
  res = fake(); cookie(res, 'token'); assert.equal(res.h['clear-site-data'], undefined);
});

test('routes use the layered cache; one query for session + version; Redis only after a memory miss', () => {
  const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  for (const [file, re] of [['api/_routes/dashboard.js', /cachedForUser\(req,'dashboard',/], ['api/_routes/ledger.js', /cachedForUser\(req,'ledger',/], ['api/_routes/snapshot.js', /cachedForUser\(req,'snapshots',/],
    ['api/_routes/account-detail.js', /cachedForUser\(req, 'account-detail',/], ['api/_routes/rewards.js', /cachedValue\(req, who\.uid, 'rewards',/], ['api/_routes/interest.js', /cachedValue\(req, who\.uid, 'interest',/]]) {
    const src = read(file); assert.match(src, re, file); assert.match(src, /sendCached\(res,\s?/, file + ' sends via sendCached');
  }
  const lib = read('api/_lib.js');
  assert.match(lib, /SELECT u\.session_version,\(SELECT version FROM wealth_data_version WHERE id=1\) AS data_version FROM wealth_users u WHERE u\.id=\$1/);
  assert.match(lib, /Promise\.all\(\[whoPromise,mem\?null:cacheGet\(key\)\]\)/, 'Redis read skipped when memory has the entry');
  assert.match(lib, /const CACHE_PREFIX='wealth:c2:'\+DEPLOY_ID\+':';/, 'a new deploy never serves an older build');
  const vercel = JSON.parse(read('vercel.json'));
  const api = vercel.headers.find(h => h.source === '/api/(.*)');
  assert.equal(api.headers.find(h => h.key === 'Cache-Control').value, 'private, no-cache');
  assert.equal(api.headers.find(h => h.key === 'CDN-Cache-Control').value, 'no-store', 'the CDN never stores API data');
});
