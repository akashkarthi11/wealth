import { sql, json, configStatus } from './_lib.js';

// GET /api/health — which settings this deployment has, as yes/no only (never values), plus whether the
// database answers and which migrations are applied. Open it on each environment to compare them.
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const status = configStatus();
  let database = { reachable: false };
  if (sql) {
    try {
      const [row] = await sql.query(`SELECT
        (SELECT count(*)::int FROM wealth_schema_migrations) AS migrations,
        (SELECT max(id) FROM wealth_schema_migrations) AS latest`);
      database = { reachable: true, migrationsApplied: row.migrations, latestMigration: row.latest };
    } catch (e) {
      database = e?.code === '42P01' ? { reachable: true, migrationsApplied: 0 } : { reachable: false, error: 'query failed' };
    }
  }
  const problems = [];
  if (!status.database.configured) problems.push('no database URL');
  if (status.database.configured && !database.reachable) problems.push('database not reachable');
  if (!status.sessionSecret) problems.push('WEALTH_SESSION_SECRET missing or shorter than 32 characters (login fails)');
  if (!status.accessKey) problems.push('WEALTH_ACCESS_KEY missing (registration disabled)');
  if (status.redis === 'invalid (ignored)') problems.push('REDIS_URL is not a redis:// URL (caching and rate limits off)');
  if (status.environment === 'production' && !status.cronSecret) problems.push('CRON_SECRET missing (daily price refresh is rejected)');
  return json(res, problems.some(p => /database|SESSION_SECRET/.test(p)) ? 503 : 200, { ok: problems.length === 0, problems, config: status, database });
}
