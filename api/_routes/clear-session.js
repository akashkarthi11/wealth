import { cookie, json, sql, sessionFrom, withActor } from '../_lib.js';

// GET  /api/clear-session  drop this browser's login cookie and go to the sign-in page (works even when signed out).
// POST /api/clear-session  "Clear session": end the login on EVERY device (session_version + 1, so every older session
//                          token stops working) and drop this browser's cookie. Financial records are untouched.
export default async function handler(req, res) {
  if (req.method === 'GET') {
    cookie(res, '');
    res.statusCode = 303;
    res.setHeader('Location', '/');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'Method not allowed' }); }
  const s = sessionFrom(req);
  let everywhere = false;
  if (s && sql) {
    try {
      const [upd] = await withActor(sql, 'owner', [[`UPDATE wealth_users SET session_version = coalesce(session_version, 1) + 1
        WHERE id = $1 AND coalesce(session_version, 1) = $2 RETURNING id`, [s.uid, s.sv]]]);
      everywhere = upd.length > 0;
    } catch (e) { console.error('[wealth-clear-session]', e?.message || e); }
  }
  cookie(res, '');
  return json(res, 200, { ok: true, everywhere });
}
