import { sql, schema, json, body, sessionUser, check, sendError, invalidateUserCaches, rateLimit, rateCount, rateReset } from '../_lib.js';
import { importAll } from '../_upload.js';

// POST /api/uploads {password, transactions[], accounts[], lending[], investments[]} — save the rows as the signed-in user's own data.
// The account password is required on every upload (nothing is remembered), and wrong passwords are rate limited.
const WINDOW = 15 * 60, LIMIT = 5;
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    const key = 'upload:pw:' + uid;
    if ((await rateCount(key)) >= LIMIT) { res.setHeader('Retry-After', String(WINDOW)); return json(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes and try again.' }); }
    const b = await body(req, 400000);
    const [u] = await sql.query('SELECT password_hash FROM wealth_users WHERE id=$1', [uid]);
    if (!u || !check(String(b.password || ''), u.password_hash)) {
      await rateLimit(key, LIMIT, WINDOW);
      return json(res, 403, { error: 'Password is incorrect.' });
    }
    await rateReset(key);
    const r = await importAll(uid, { transactions: b.transactions ?? b.rows, accounts: b.accounts, lending: b.lending, investments: b.investments }, { actor: 'user' });
    if (r.added) await invalidateUserCaches(uid);
    return json(res, 200, r);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message, details: e.details });
    console.error('[wealth-uploads]', e?.message || e);
    return json(res, 500, { error: 'Unable to upload.' });
  }
}
