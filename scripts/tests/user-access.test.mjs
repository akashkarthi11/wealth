// 2026-11-12: a signed-in non-admin user (test@gmail.com) may open every per-user module and sees only their own data.
// Source-level checks, in the style of menu.test.mjs: the gate is the `user:true` flag on authorize(); the owner-only
// features (password reset, v1 ↔ v2 switch, clear session, data quality, Angel One, prices, rates) stay admin-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('authorize(): admin always passes; a plain user passes only on routes that opt in with user:true', () => {
  const lib = read('api/_lib.js');
  assert.match(lib, /async function authorize\(req,\{ingest=true,cron=false,session=true,user=false\}/);
  assert.match(lib, /if\(u\?\.role==='admin'\)return \{uid,actor:'owner'\};/);
  assert.match(lib, /return u&&user\?\{uid,actor:'user'\}:\{status:403,error:'Owner only'\};/);
  // Agents and cron still resolve to the owner account only.
  assert.match(lib, /const uid=await ownerId\(\);\s*return uid\?\{uid,actor\}/);
});

test('per-user module routes opt in; owner-only routes do not', () => {
  const on = ['accounts', 'holdings', 'obligations', 'transaction-review', 'loans', 'rewards', 'splits', 'interest'];
  for (const r of on) assert.match(read(`api/_routes/${r}.js`), /user: true/, `${r} should allow a signed-in user`);
  const off = ['prices', 'balances', 'email-imports', 'nightly', 'angel', 'data-quality', 'reconcile'];
  for (const r of off) {
    let src = ''; try { src = read(`api/_routes/${r}.js`); } catch { continue; }
    assert.doesNotMatch(src, /user: true/, `${r} must stay owner-only`);
  }
  // Shared tables stay owner-only inside the interest route: rates, run and credits do not opt in.
  assert.match(read('api/_routes/interest.js'), /'interest\/rates': \{\}, 'interest\/run': \{ cron: true \}, 'interest\/credits': \{\}/);
});

test('UI keeps reset password, the v1 switch and clear session for the admin only', () => {
  const app = read('app.js');
  assert.match(app, /user\?\.role==='admin'\?'<button type="button" class="more-link" data-action="reset-password">/);
  assert.match(app, /user\?\.role==='admin'\?'<button type="button" class="more-link" data-action="clear-session">/);
  assert.match(app, /Compare with old dashboard \(v1\)/);
  const dash = read('api/_routes/dashboard.js');
  assert.match(dash, /const wantV2=admin&&asked==='v1'\?false:admin&&asked==='v2'\?true:defaultV2;/);
  assert.doesNotMatch(dash, /rewards:admin\?/);
});
