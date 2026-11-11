// Sign out and Clear session (2026-11-11, owner: "signout, clear session not working properly").
// Sign-out must not send Clear-Site-Data (Chrome held the response, the cookie was never removed); Clear session
// (POST) ends every session and clears the cookie; GET still works as a plain "drop this browser's cookie" link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cookie } from '../../api/_lib.js';
import clearSession from '../../api/_routes/clear-session.js';

function fakeRes() {
  const h = {}; let body = '';
  return { h, get body() { return body; }, statusCode: 200, setHeader(k, v) { h[k.toLowerCase()] = v; }, end(b) { body = b || ''; } };
}

test('sign-out cookie: expires the session, no Clear-Site-Data', () => {
  const res = fakeRes();
  cookie(res, '');
  assert.match(res.h['set-cookie'], /^wealth_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  assert.equal(res.h['clear-site-data'], undefined);
});

test('clear-session: GET drops the cookie and goes to sign-in; POST without a session still clears the cookie', async () => {
  const g = fakeRes();
  await clearSession({ method: 'GET', headers: {} }, g);
  assert.deepEqual([g.statusCode, g.h.location, /Max-Age=0/.test(g.h['set-cookie'])], [303, '/', true]);
  const p = fakeRes();
  await clearSession({ method: 'POST', headers: {} }, p);
  assert.deepEqual([p.statusCode, JSON.parse(p.body), /Max-Age=0/.test(p.h['set-cookie'])], [200, { ok: true, everywhere: false }, true]);
  const d = fakeRes();
  await clearSession({ method: 'DELETE', headers: {} }, d);
  assert.equal(d.statusCode, 405);
});

test('page: sign-out uses a plain fetch with a fallback, Clear session is a confirmed POST that ends every device', () => {
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const signOut = src.slice(src.indexOf('async function signOut()'), src.indexOf('async function clearSession()'));
  assert.match(signOut, /fetch\('\/api\/auth\?action=logout'/);
  assert.match(signOut, /location\.replace\('\/api\/clear-session'\)/);
  assert.ok(!/location\.reload\(\)/.test(signOut), 'no reload: replace() so Back does not show the old screen');
  const clear = src.slice(src.indexOf('async function clearSession()'), src.indexOf('async function clearSession()') + 900);
  assert.match(clear, /confirm\(/);
  assert.match(clear, /fetch\('\/api\/clear-session',\{method:'POST'/);
  assert.match(src, /data-action="clear-session"/);
  assert.ok(!src.includes('href="/api/clear-session"'), 'no GET link that ends the session silently');
});
