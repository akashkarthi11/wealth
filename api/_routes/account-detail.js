import { json, schema, sessionUser, isUuid, sendError } from '../_lib.js';
import { accountDetail } from '../_queries.js';

// GET /api/account-detail?id=<account uuid> — one account's page from the tables (signed-in user, own accounts only).
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    const id = new URL(req.url, 'https://local').searchParams.get('id');
    if (!isUuid(id)) return json(res, 400, { error: 'id must be an account id' });
    const detail = await accountDetail(uid, id);
    return detail ? json(res, 200, detail) : json(res, 404, { error: 'Account not found' });
  } catch (e) { return sendError(res, e, 'wealth-account-detail'); }
}
