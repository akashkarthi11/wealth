import { json, schema, isUuid, sendError, cachedForUser, cacheHeader } from '../_lib.js';
import { accountDetail } from '../_queries.js';

// GET /api/account-detail?id=<account uuid> — one account's page from the tables (signed-in user, own accounts only).
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    await schema();
    const id = new URL(req.url, 'https://local').searchParams.get('id');
    if (!isUuid(id)) return json(res, 400, { error: 'id must be an account id' });
    // Versioned Redis cache (0018); the IST day is in the key because the page shows this month's money in / out.
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const { uid, data, hit } = await cachedForUser(req, 'account-detail', u => accountDetail(u, id).then(d => d || { notFound: true }), { variant: id + ':' + day });
    if (!uid) return json(res, 401, { error: 'Sign in required' });
    cacheHeader(res, hit);
    return data && !data.notFound ? json(res, 200, data) : json(res, 404, { error: 'Account not found' });
  } catch (e) { return sendError(res, e, 'wealth-account-detail'); }
}
