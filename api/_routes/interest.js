import { json, handle, invalidateUserCaches, cachedValue, sendCached } from '../_lib.js';
import { runAccrual, submitRate, recordCredit, interestOverview } from '../_interest.js';
import { startJob, finishJob } from '../_jobs.js';

// GET  /api/interest           interest view: sources, current rates, accrued and credited (TR3-3.7, owner)
// POST /api/interest/rates     verified rate period (TR3-3.2, agent or owner; ?dryRun=1)
// POST /api/interest/run       accrue through yesterday IST, idempotent (TR3-3.5, cron / agent / owner; ?dryRun=1)
// POST /api/interest/credits   actual credit with bank evidence (TR3-3.6, owner or agent; unique reference)
const AUTH = { 'interest': {}, 'interest/rates': {}, 'interest/run': { cron: true }, 'interest/credits': {} };

export default handle('wealth-interest', { methods: ['GET', 'POST'], auth: req => AUTH[req.route] || { ingest: false } }, async ({ req, res, who, body, dryRun }) => {
  const route = req.route || 'interest';
  if (route === 'interest') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    return sendCached(res, await cachedValue(req, who.uid, 'interest', () => interestOverview(who.uid), { variant: day }));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (route === 'interest/rates') { const r = await submitRate(body, { actor: who.actor, dryRun }); return json(res, r.status, r.body); }
  if (route === 'interest/credits') { const r = await recordCredit(who.uid, body, { actor: who.actor }); await invalidateUserCaches(who.uid); return json(res, 201, r); }
  const run = dryRun ? null : await startJob('interest-accrual');
  try {
    const r = await runAccrual(who.uid, { actor: who.actor, dryRun });
    await finishJob(run, 'succeeded', { through: r.through, rows: r.accounts.reduce((s, a) => s + a.rowsWritten, 0) });
    if (!dryRun) await invalidateUserCaches(who.uid);
    return json(res, 200, r);
  } catch (e) { await finishJob(run, 'failed', { error: String(e?.message || e).slice(0, 200) }); throw e; }
});
