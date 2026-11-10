import { sql, schema, json, body, sessionUser } from '../_lib.js';
import { collectIssues } from '../_dataquality.js';

// GET  /api/data-quality             — open data-quality issues (owner only)
// POST /api/data-quality {issueId, reason} — accept a known issue with a reason (kept, never deleted)
export default async function handler(req, res) {
  try {
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    const [u] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
    if (u?.role !== 'admin') return json(res, 403, { error: 'Owner only' });
    if (req.method === 'GET') return json(res, 200, await collectIssues(uid));
    if (req.method === 'POST') {
      const b = await body(req);
      const issueId = String(b.issueId || '').trim().slice(0, 300);
      const reason = String(b.reason || '').trim().slice(0, 500);
      if (!issueId || reason.length < 3) return json(res, 400, { error: 'Give the issue id and a reason (at least 3 characters).' });
      const rows = await sql.query(`INSERT INTO wealth_data_quality_acceptances (user_id, issue_id, reason) VALUES ($1, $2, $3)
        ON CONFLICT (user_id, issue_id) DO UPDATE SET reason = EXCLUDED.reason, accepted_at = now() RETURNING issue_id, reason, accepted_at`, [uid, issueId, reason]);
      return json(res, 200, { accepted: rows[0] });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('[wealth-data-quality]', e?.message || e);
    return json(res, 500, { error: 'Unable to check data quality.' });
  }
}
