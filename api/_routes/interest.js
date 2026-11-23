import { json, handle, invalidateUserCaches, cachedValue, sendCached } from '../_lib.js';
import { submitRate, interestOverview, saveInterestAccount } from '../_interest.js';

// GET  /api/interest           interest view: sources, current rates, accrued and credited (TR3-3.7, owner)
// POST /api/interest/rates     verified rate period (TR3-3.2, agent or owner; ?dryRun=1)
// POST /api/interest/run       accrue through yesterday IST, idempotent (TR3-3.5, cron / agent / owner; ?dryRun=1)
// POST /api/interest/credits   actual credit with bank evidence (TR3-3.6, owner or agent; unique reference)
// POST /api/interest/accounts   set up an account: rate per year, how the interest is paid, period start, pause (any signed-in user, own accounts)
const AUTH = { 'interest': { user: true }, 'interest/accounts': { user: true, ingest: false }, 'interest/rates': {}, 'interest/run': { cron: true }, 'interest/credits': {} };

export default handle('wealth-interest', { methods: ['GET', 'POST'], auth: req => AUTH[req.route] || { ingest: false } }, async ({ req, res, who, body, dryRun }) => {
  const route = req.route || 'interest';
  if (route === 'interest') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    return sendCached(res, await cachedValue(req, who.uid, 'interest', () => interestOverview(who.uid), { variant: day }));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (route === 'interest/accounts') { const r = await saveInterestAccount(who.uid, body, { actor: who.actor }); await invalidateUserCaches(who.uid); return json(res, 200, r); }
  if (route === 'interest/rates') { const r = await submitRate(body, { actor: who.actor, dryRun }); return json(res, r.status, r.body); }
  if (route === 'interest/credits' || route === 'interest/run') {
    return json(res, 410, { error: 'Interest credits and accrual are owned exclusively by the nightly /api/nightly job.' });
  }
  return json(res, 404, { error: 'Not found' });
});
