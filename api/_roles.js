import { sql } from './_lib.js';

// Role management (0027). Roles are fixed: admin (always sees every menu) and user (the admin picks its menus).
// Hiding a menu hides it in the app; it is not a data permission.
export const MENUS = [
  { key: 'overview', label: 'Overview', group: 'Money' },
  { key: 'banks', label: 'Banks', group: 'Money' },
  { key: 'investments', label: 'Investments', group: 'Money' },
  { key: 'interest', label: 'Interest', group: 'Money' },
  { key: 'rewards', label: 'Rewards', group: 'Money' },
  { key: 'lending', label: 'People', group: 'Money' },
  { key: 'transactions', label: 'Transactions', group: 'Activity' },
  { key: 'alerts', label: 'Alerts', group: 'Activity' },
  { key: 'subscriptions', label: 'Subscriptions', group: 'Activity' },
  { key: 'upload', label: 'Upload', group: 'Activity' },
  { key: 'offers', label: 'Account offers', group: 'Money' },
];
const KEYS = MENUS.map(m => m.key);
const err = (status, message) => Object.assign(new Error(message), { status });

// null = every menu (admin, or a role with nothing saved).
export async function menusForRole(role, { db = sql } = {}) {
  if (role === 'admin') return null;
  const [r] = await db.query('SELECT menus FROM wealth_role_menus WHERE role=$1', [role]);
  return r ? r.menus.filter(k => KEYS.includes(k)) : null;
}

export async function rolesOverview({ db = sql } = {}) {
  const users = await db.query('SELECT role, count(*)::int AS n FROM wealth_users GROUP BY role');
  const n = r => users.find(u => u.role === r)?.n || 0;
  const user = await menusForRole('user', { db });
  return {
    menus: MENUS,
    roles: [
      { role: 'admin', label: 'Admin', users: n('admin'), locked: true, menus: KEYS },
      { role: 'user', label: 'User', users: n('user'), locked: false, menus: user || KEYS },
    ],
  };
}

export async function setRoleMenus(uid, { role, menus }, { db = sql } = {}) {
  if (role === 'admin') throw err(400, 'The admin role always sees every menu.');
  if (role !== 'user') throw err(400, 'Unknown role.');
  if (!Array.isArray(menus)) throw err(400, 'Choose the menus.');
  const clean = KEYS.filter(k => menus.includes(k));
  if (menus.some(k => !KEYS.includes(k))) throw err(400, 'Unknown menu.');
  if (!clean.length) throw err(400, 'Choose at least one menu.');
  await db.query(`INSERT INTO wealth_role_menus(role, menus, updated_by) VALUES($1,$2,$3)
    ON CONFLICT (role) DO UPDATE SET menus=EXCLUDED.menus, updated_at=now(), updated_by=EXCLUDED.updated_by`, [role, clean, uid]);
  return { role, menus: clean };
}

// Data behind a menu is blocked for roles without it. A route lists every menu that uses it; a role may call it when it
// has at least one. Shared core routes (dashboard, accounts, auth, health, prices…) are not listed: every page needs them.
export const ROUTE_MENUS = {
  'rewards': ['rewards', 'overview', 'banks'],
  'loans': ['lending', 'transactions'],
  'splits': ['banks', 'lending', 'transactions'],
  'interest': ['interest', 'overview', 'banks'],
  'planned-bills': ['alerts', 'subscriptions', 'overview'],
  'obligations': ['alerts', 'subscriptions', 'overview'],
  'transaction-review': ['transactions', 'overview'],
  'ledger': ['transactions', 'overview', 'banks'],
  'positions': ['investments', 'overview'],
  'holdings': ['investments', 'overview', 'banks'],
  'account-detail': ['banks'],
  'uploads': ['upload'],
  'transaction-accept': ['transactions', 'overview'],
  'account-offers': ['offers'],
};
// menus = null means every menu.
export function routeAllowed(route, menus) {
  const need = ROUTE_MENUS[String(route || '').split('/')[0]];
  if (!need || !Array.isArray(menus)) return true;
  return need.some(k => menus.includes(k));
}
export const guardedRoute = route => Object.prototype.hasOwnProperty.call(ROUTE_MENUS, String(route || '').split('/')[0]);

// Tools (Stock Advisor, Angel One, Records) and Settings / Data quality are for the admin only (2026-11-14).
// Scheduled agents that post with their own token are not affected: this applies to signed-in non-admin users.
export const ADMIN_ONLY_VIEWS = ['stock-advisor', 'angel-one', 'other', 'data-quality', 'settings'];
export const ADMIN_ONLY_ROUTES = ['stock-advisor', 'angel'];
export const adminOnlyRoute = route => ADMIN_ONLY_ROUTES.includes(String(route || '').split('/')[0]);
