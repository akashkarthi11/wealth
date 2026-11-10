import { json, sql, safeEqual, ownerId, invalidateUserCaches } from '../_lib.js';
import { runAccrual } from '../_interest.js';
import { runBackup } from '../_backup.js';
import { startJob, finishJob } from '../_jobs.js';

// Vercel Cron, daily 20:00 UTC (01:30 IST): interest accrual through yesterday (TR3-3.5), then the encrypted
// off-site backup (TR3-6.1). One cron entry so the Hobby plan's limits are respected.
// Each part records its own job run; one failing does not stop the other.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (secret.length < 16 || !safeEqual(String(req.headers.authorization || ''), 'Bearer ' + secret)) return json(res, 401, { error: 'Unauthorized' });
  if (!sql) return json(res, 503, { error: 'Database is not configured' });
  const out = {};
  const accrualRun = await startJob('interest-accrual');
  try {
    const uid = await ownerId();
    const r = uid ? await runAccrual(uid, { actor: 'cron' }) : { accounts: [] };
    out.interest = { through: r.through, accounts: r.accounts.map(a => ({ accountKey: a.accountKey, status: a.status, rowsWritten: a.rowsWritten })) };
    await finishJob(accrualRun, 'succeeded', { through: r.through, rows: r.accounts.reduce((s, a) => s + a.rowsWritten, 0) });
    if (uid) await invalidateUserCaches(uid);
  } catch (e) {
    out.interest = { error: 'failed' };
    console.error('[wealth-nightly:interest]', e?.message || e);
    await finishJob(accrualRun, 'failed', { error: String(e?.message || e).slice(0, 200) });
  }
  const backupRun = await startJob('backup');
  try {
    out.backup = await runBackup();
    await finishJob(backupRun, 'succeeded', out.backup);
  } catch (e) {
    const notConfigured = e?.code === 'CONFIG';
    out.backup = { error: notConfigured ? e.message : 'failed' };
    console.error('[wealth-nightly:backup]', e?.message || e);
    await finishJob(backupRun, notConfigured ? 'partial' : 'failed', { error: String(e?.message || e).slice(0, 200), notConfigured });
  }
  return json(res, 200, out);
}
