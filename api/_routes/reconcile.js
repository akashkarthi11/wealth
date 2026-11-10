import { sql, schema, json, sessionUser } from '../_lib.js';
import { legacyAccountRows, legacyPositionRows, accountHierarchyRows } from '../_queries.js';
import { valuePortfolio } from '../_valuation.js';
import { v1Totals, reconcile } from '../_reconcile.js';

// GET /api/reconcile — owner only. v1 (live dashboard rules) vs v2 (account model), per category,
// each difference with a reason. `acceptable` is the switch gate (TSD Claude Plan 2, TR2-D.2).
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    const [u] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
    if (u?.role !== 'admin') return json(res, 403, { error: 'Owner only' });
    const [accounts, positions, rows] = await Promise.all([legacyAccountRows(uid), legacyPositionRows(uid), accountHierarchyRows(uid)]);
    return json(res, 200, { generatedAt: new Date().toISOString(), ...reconcile(v1Totals(accounts, positions), valuePortfolio(rows)) });
  } catch (e) {
    console.error('[wealth-reconcile]', e?.message || e);
    return json(res, 500, { error: 'Unable to reconcile.' });
  }
}
