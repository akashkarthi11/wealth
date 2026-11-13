// Role management (migration 0027, 2026-11-12): the admin chooses which menus the User role sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { MENUS, menusForRole, rolesOverview, setRoleMenus } from '../../api/_roles.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user')`);
  return { a, uid: u.id };
}

test('default: nothing saved means the User role sees every menu; admin always does', async () => {
  const { a } = await setup();
  assert.equal(await menusForRole('user', { db: a }), null);
  assert.equal(await menusForRole('admin', { db: a }), null);
  const o = await rolesOverview({ db: a });
  assert.deepEqual(o.roles.map(r => [r.role, r.users, r.locked, r.menus.length]), [['admin', 1, true, MENUS.length], ['user', 1, false, MENUS.length]]);
});

test('admin picks the menus of the User role; saved, ordered, and shown in the overview', async () => {
  const { a, uid } = await setup();
  await setRoleMenus(uid, { role: 'user', menus: ['transactions', 'overview', 'banks'] }, { db: a });
  assert.deepEqual(await menusForRole('user', { db: a }), ['overview', 'banks', 'transactions']);
  assert.equal((await rolesOverview({ db: a })).roles[1].menus.length, 3);
  await setRoleMenus(uid, { role: 'user', menus: ['overview'] }, { db: a });
  assert.deepEqual(await menusForRole('user', { db: a }), ['overview']);
});

test('validation: admin role locked, unknown role/menu, empty and non-list are refused', async () => {
  const { a, uid } = await setup();
  for (const b of [{ role: 'admin', menus: ['overview'] }, { role: 'boss', menus: ['overview'] }, { role: 'user', menus: ['nope'] }, { role: 'user', menus: [] }, { role: 'user', menus: 'overview' }, { role: 'user', menus: ['data-quality'] }])
    await assert.rejects(setRoleMenus(uid, b, { db: a }), e => e.status === 400, JSON.stringify(b));
});

test('wiring: admin-only route, menus sent with the session, UI hides menus and guards views', () => {
  assert.match(read('api/_routes/roles.js'), /u\?\.role !== 'admin'\) return json\(res, 403/);
  assert.match(read('api/router.js'), /'roles': \(\) => import/);
  assert.match(read('api/_routes/auth.js'), /menusForRole/);
  const app = read('app.js');
  for (const s of ['function guardView', 'function applyMenus', 'view=guardView(view)', 'data-role-open', '/api/roles', "view==='settings'"]) assert.ok(app.includes(s), s);
  assert.match(read('index.html'), /data-view="settings"[^>]*data-owner-only/);
  assert.doesNotMatch(read('scripts/migrations/0027_role_menus.sql'), /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM/i);
});

test('API: data behind a hidden menu is blocked; shared core routes and full access are not', async () => {
  const { routeAllowed, guardedRoute, ROUTE_MENUS } = await import('../../api/_roles.js');
  assert.equal(routeAllowed('loans/entries', ['overview', 'banks']), false);
  assert.equal(routeAllowed('loans/entries', ['transactions']), true);
  assert.equal(routeAllowed('uploads', ['overview']), false);
  assert.equal(routeAllowed('rewards/events', ['overview']), true, 'overview shows a rewards tile');
  assert.equal(routeAllowed('loans', null), true, 'nothing saved = all menus');
  for (const core of ['dashboard', 'auth', 'accounts', 'health', 'roles', 'lend-view']) assert.equal(guardedRoute(core), false, core);
  for (const r of Object.keys(ROUTE_MENUS)) assert.ok(guardedRoute(r + '/x'), r);
  const router = read('api/router.js');
  assert.match(router, /guardedRoute\(route\)/);
  assert.match(router, /Your role cannot open this menu/);
  assert.match(router, /u\.role !== 'admin'/);
});

test('Tools (Stock Advisor, Angel One, Records) are admin-only and not offered in Role management', async () => {
  const { MENUS, adminOnlyRoute, ADMIN_ONLY_VIEWS } = await import('../../api/_roles.js');
  for (const k of ['stock-advisor', 'angel-one', 'other']) { assert.ok(!MENUS.some(m => m.key === k), k + ' is not a role menu'); assert.ok(ADMIN_ONLY_VIEWS.includes(k)); }
  assert.ok(adminOnlyRoute('stock-advisor') && adminOnlyRoute('angel') && !adminOnlyRoute('loans'));
  assert.match(read('api/router.js'), /adminOnlyRoute\(route\) \|\| !routeAllowed/);
  assert.match(read('app.js'), /OWNER_VIEWS=\["data-quality","settings","stock-advisor","angel-one","other"\]/);
});
