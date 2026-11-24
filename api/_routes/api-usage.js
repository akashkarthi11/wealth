import { sql, json, sessionUser } from '../_lib.js';
import { buildProviderDirectory } from '../_lib/provider-directory.js';

// GET /api/api-usage   (admin only, read only)
// What each outside provider allows, what has been used today, and what is left. Limits are only shown where the
// provider actually publishes one and the code enforces it; everything else says so rather than inventing a number.
// The provider list itself (quotas, usage, health) lives in provider-directory.js, shared with Provider Health
// (loadResearchHealth in stock-advisor.js) so the two pages cannot show two different answers (2026-11-24).

async function adminUser(req) {
  const uid = await sessionUser(req);
  if (!uid) return null;
  const [user] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
  return user?.role === 'admin' ? uid : null;
}

export default async function handler(req, res) {
  try {
    if (!sql) return json(res, 503, { error: 'Database is not configured' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const uid = await adminUser(req);
    if (!uid) return json(res, 403, { error: 'Admin sign-in required' });

    const { providers } = await buildProviderDirectory(sql);

    // The latest audited response per provider: what the outside service actually returned, shape and all.
    const audit = await sql.query(`SELECT DISTINCT ON (provider) provider, ticker, endpoint, http_status, ok, usable,
        duration_ms, bytes, response_keys, data_keys, section_counts, sample, error, created_at
      FROM wealth_api_audit ORDER BY provider, created_at DESC`).catch(() => []);
    const auditByProvider = new Map(audit.map(a => [a.provider, a]));
    for (const p of providers) {
      const a = auditByProvider.get(p.name) || auditByProvider.get(p.key);
      if (a) p.audit = a;
    }
    return json(res, 200, { day: 'today, IST', providers, audit, generated_at: new Date().toISOString(),
      config_note: 'Keys are environment variables in the Vercel project. They are never shown here and cannot be changed from the app.' });
  } catch (error) {
    console.error('[api-usage]', error?.message || error);
    return json(res, 500, { error: 'Could not load API usage.' });
  }
}
