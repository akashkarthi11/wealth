import { json, sql, safeEqual, ownerId, invalidateUserCaches } from '../_lib.js';
import { runAccrual } from '../_interest.js';
import { runBackup } from '../_backup.js';
import { startJob, finishJob } from '../_jobs.js';

// Vercel Cron, daily 20:00 UTC (01:30 IST): interest accrual through yesterday, then encrypted off-site backup.
// Each part records its own run; both are attempted even if the first fails.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (secret.length < 16 || !safeEqual(String(req.headers.authorization || ''), 'Bearer ' + secret)) return json(res, 401, { error: 'Unauthorized' });
  if (!sql) return json(res, 503, { error: 'Database is not configured' });
  const out = {};
  let failed = false;
  const accrualRun = await startJob('interest-accrual');
  try {
    const uid = await ownerId();
    const others = (await sql.query(`SELECT DISTINCT a.user_id FROM wealth_interest_links l JOIN wealth_accounts a ON a.id = l.account_id
      WHERE a.status = 'active'`).catch(() => [])).map(r => r.user_id).filter(u => u && u !== uid);
    const r = uid ? await runAccrual(uid, { actor: 'cron' }) : { accounts: [] };
    out.interest = { through: r.through, accounts: r.accounts.map(a => ({ accountKey: a.accountKey, status: a.status, rowsWritten: a.rowsWritten })), otherUsers: others.length };
    let rows = r.accounts.reduce((s, a) => s + a.rowsWritten, 0), userFailures = 0;
    if (uid) await invalidateUserCaches(uid);
    for (const u of others) {
      try { const o = await runAccrual(u, { actor: 'cron' }); rows += o.accounts.reduce((s, a) => s + a.rowsWritten, 0); await invalidateUserCaches(u); }
      catch (e) { userFailures++; console.error('[wealth-nightly:interest:user]', e?.message || e); }
    }
    out.interest.rowsWritten = rows;
    out.interest.failedUsers = userFailures;
    await finishJob(accrualRun, userFailures ? 'partial' : 'succeeded', { through: r.through, rows, users: (uid ? 1 : 0) + others.length, failed: userFailures });
    if (userFailures) failed = true;
  } catch (e) {
    out.interest = { status: 'failed', error: String(e?.message || e).slice(0, 200) };
    failed = true;
    console.error('[wealth-nightly:interest]', e?.message || e);
    await finishJob(accrualRun, 'failed', { error: String(e?.message || e).slice(0, 200) });
  }
  const backupRun = await startJob('backup');
  try {
    out.backup = { status: 'succeeded', ...(await runBackup()) };
    await finishJob(backupRun, 'succeeded', out.backup);
  } catch (e) {
    const notConfigured = e?.code === 'CONFIG';
    out.backup = { status: notConfigured ? 'not_configured' : 'failed', error: String(e?.message || e).slice(0, 200) };
    failed = true;
    console.error('[wealth-nightly:backup]', e?.message || e);
    await finishJob(backupRun, notConfigured ? 'partial' : 'failed', { error: String(e?.message || e).slice(0, 200), notConfigured });
  }
  return json(res, failed ? 500 : 200, { ok: !failed, ...out });
}
