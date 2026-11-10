import { sql, json, configStatus } from '../_lib.js';
import { jobActivity } from '../_jobs.js';

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
      // v2 sync problems in the last 24 h (table exists from migration 0006).
      const issues = await sql.query(`SELECT count(*)::int AS n, max(occurred_at) AS last FROM wealth_sync_issues WHERE occurred_at > now() - interval '24 hours'`).catch(() => null);
      if (issues) database.syncIssues24h = { count: issues[0].n, last: issues[0].last };
    } catch (e) {
      database = e?.code === '42P01' ? { reachable: true, migrationsApplied: 0 } : { reachable: false, error: 'query failed' };
    }
  }
  // Job activity (TSD Claude Plan 2, Phase G): last run per job and latest work done by the agents.
  let jobs = null;
  if (database.reachable) {
    const act = await jobActivity().catch(() => null);
    if (act) jobs = {
      lastRuns: Object.fromEntries(act.runs.map(r => [r.job, { startedAt: r.started_at, status: r.status }])),
      failingTwice: act.failingTwice,
      advisorLastReport: act.external.advisor_last || null,
      gmailLastImport: act.external.gmail_last || null,
      interestLastAccrualDate: act.external.interest_last_date || null,
      pricesLastStored: act.external.prices_last || null,
    };
  }
  const hoursSince = x => (x ? (Date.now() - new Date(x).getTime()) / 3600e3 : Infinity);
  const problems = [];
  if (jobs) {
    const refresh = jobs.lastRuns['price-refresh'];
    if (!refresh) problems.push('price refresh has never run');
    else if (hoursSince(refresh.startedAt) > 36) problems.push(`price refresh last ran ${Math.round(hoursSince(refresh.startedAt))} h ago`);
    for (const job of jobs.failingTwice) problems.push(`${job} failed on its last two runs`);
    for (const job of ['interest-accrual', 'backup']) {
      const r = jobs.lastRuns[job];
      if (r && hoursSince(r.startedAt) > 36) problems.push(`${job} last ran ${Math.round(hoursSince(r.startedAt))} h ago`);
      if (r && job === 'backup' && r.status !== 'succeeded') problems.push('last backup was not stored');
    }
    if (jobs.advisorLastReport && hoursSince(jobs.advisorLastReport) > 3) problems.push(`no Stock Advisor report for ${Math.round(hoursSince(jobs.advisorLastReport))} h`);
  }
  if (!status.database.configured) problems.push('no database URL');
  if (status.database.configured && !database.reachable) problems.push('database not reachable');
  if (!status.sessionSecret) problems.push('WEALTH_SESSION_SECRET missing or shorter than 32 characters (login fails)');
  if (!status.accessKey) problems.push('WEALTH_ACCESS_KEY missing (registration disabled)');
  if (status.redis === 'invalid (ignored)') problems.push('REDIS_URL is not a redis:// URL (caching and rate limits off)');
  if (database.syncIssues24h?.count) problems.push(`${database.syncIssues24h.count} legacy→v2 sync issue(s) in the last 24 h (see wealth_sync_issues)`);
  if (status.environment === 'production' && !status.cronSecret) problems.push('CRON_SECRET missing (daily price refresh and nightly jobs are rejected)');
  if (status.environment === 'production' && !status.backup) problems.push('backups not configured (WEALTH_BACKUP_KEY, BLOB_READ_WRITE_TOKEN)');
  return json(res, problems.some(p => /database|SESSION_SECRET/.test(p)) ? 503 : 200, { ok: problems.length === 0, problems, config: status, database, jobs });
}
