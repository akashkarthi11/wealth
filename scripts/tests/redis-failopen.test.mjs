// Redis is optional: an unreachable or misconfigured Redis must never block or crash a request.
// Regression: login hung past Vercel's 10 s limit when REDIS_URL pointed at an unreachable host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function run(redisUrl, script) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, REDIS_URL: redisUrl, WEALTH_SESSION_SECRET: 'x'.repeat(40), REDIS_OP_TIMEOUT_MS: '500' },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const SCRIPT = `
const lib = await import('./api/_lib.js');
const t0 = Date.now();
const count = await lib.rateCount('login:ip:test');
const t1 = Date.now();
const limit = await lib.rateLimit('login:ip:test', 5, 900);
const get = await lib.cacheGet('k');
const lock = await lib.cacheLock('k', 5);
await lib.cacheDel('k');
console.log(JSON.stringify({ count, limit, get, lock, firstMs: t1 - t0, restMs: Date.now() - t1 }));
process.exit(0);`;

test('unreachable Redis: calls give up within the time limit, then Redis is skipped', () => {
  const r = run('redis://10.255.255.1:6379', SCRIPT);
  assert.equal(r.count, 0);
  assert.deepEqual(r.limit, { allowed: true, retryAfter: 0 });
  assert.equal(r.get, null);
  assert.equal(r.lock, false);
  assert.ok(r.firstMs < 2500, `first call took ${r.firstMs} ms`);
  assert.ok(r.restMs < 200, `later calls took ${r.restMs} ms (should skip Redis during the cool-down)`);
});

test('invalid REDIS_URL (e.g. a "[SENSITIVE]" placeholder) does not crash the API module', () => {
  const r = run('[SENSITIVE]', SCRIPT);
  assert.equal(r.count, 0);
  assert.equal(r.get, null);
});
