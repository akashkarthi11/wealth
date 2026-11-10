import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.WEALTH_SESSION_SECRET = 'x'.repeat(40);
delete process.env.REDIS_URL;
const lib = await import('../../api/_lib.js');

const reqWith = cookie => ({ headers: { cookie } });
const cookieFor = t => 'wealth_session=' + t;

test('password policy: 10 to 200 characters (TR-1.2)', () => {
  assert.match(lib.passwordProblem(''), /at least 10/);
  assert.match(lib.passwordProblem('123456789'), /at least 10/);
  assert.equal(lib.passwordProblem('1234567890'), null);
  assert.equal(lib.passwordProblem('a'.repeat(200)), null);
  assert.match(lib.passwordProblem('a'.repeat(201)), /too long/);
});

test('safeEqual compares secrets in constant time and rejects empty (TR-1.5)', () => {
  assert.equal(lib.safeEqual('secret-key', 'secret-key'), true);
  assert.equal(lib.safeEqual('secret-key', 'secret-kez'), false);
  assert.equal(lib.safeEqual('short', 'longer-value'), false);
  assert.equal(lib.safeEqual('', ''), false, 'an unset access key must never match');
});

test('session token carries the session version (TR-1.4)', () => {
  const t = lib.token('user-1', 3);
  assert.deepEqual(lib.sessionFrom(reqWith(cookieFor(t))), { uid: 'user-1', sv: 3 });
  assert.equal(lib.userFrom(reqWith(cookieFor(t))), 'user-1');
});

test('tokens issued before session versions default to version 1', () => {
  const body = Buffer.from(JSON.stringify({ uid: 'legacy', exp: Date.now() + 1000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.WEALTH_SESSION_SECRET).update(body).digest('base64url');
  assert.deepEqual(lib.sessionFrom(reqWith(cookieFor(body + '.' + sig))), { uid: 'legacy', sv: 1 });
});

test('tampered, expired or missing tokens are rejected', () => {
  const t = lib.token('user-1', 1);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 1e6, sv: 1 })).toString('base64url');
  assert.equal(lib.sessionFrom(reqWith(cookieFor(forged + '.' + sig))), null);
  assert.equal(lib.sessionFrom(reqWith('other=1')), null);
  assert.equal(lib.sessionFrom(reqWith(cookieFor(body))), null);
});

test('rate limiter fails open without Redis (TR-1.3)', async () => {
  const r = await lib.rateLimit('test', 1, 60);
  assert.equal(r.allowed, true);
  assert.equal(await lib.rateCount('test'), 0);
});
