import { sql, schema, json, body, sessionUser, sendError, invalidateUserCaches } from '../_lib.js';
import { rolesOverview, setRoleMenus } from '../_roles.js';

// GET  /api/roles                  — roles and the menus each can see (admin only)
// POST /api/roles {role, menus[]}  — choose the menus of a role
export default async function handler(req, res) {
  try {
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    const [u] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
    if (u?.role !== 'admin') return json(res, 403, { error: 'Owner only' });
    if (req.method === 'GET') return json(res, 200, await rolesOverview());
    if (req.method === 'POST') {
      const r = await setRoleMenus(uid, await body(req));
      await invalidateUserCaches(uid);
      return json(res, 200, r);
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (e?.status) return sendError(res, e, 'wealth-roles');
    console.error('[wealth-roles]', e?.message || e);
    return json(res, 500, { error: 'Unable to manage roles.' });
  }
}
