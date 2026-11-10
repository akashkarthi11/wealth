import { json, handle, invalidateUserCaches } from '../_lib.js';
import { storePrices } from '../_ingest.js';
import { startJob, finishJob } from '../_jobs.js';

// POST /api/prices {items:[{assetClass, symbol, price, currency, asOf, source, fxToInr?}]}  (TR3-2.1, ?dryRun=1)
// Agents (Bearer WEALTH_INGEST_SECRET) or the owner. Newest-only; USD needs fxToInr; held instruments are refused.
export default handle('wealth-prices', { methods: ['POST'] }, async ({ res, who, body, dryRun }) => {
  const run = dryRun ? null : await startJob('price-ingest');
  try {
    const r = await storePrices(who.uid, body.items, { actor: who.actor, dryRun });
    const n = s => r.results.filter(x => x.status === s).length;
    await finishJob(run, n('rejected') ? (n('stored') ? 'partial' : 'failed') : 'succeeded', { stored: n('stored'), rejected: n('rejected'), onHold: n('on_hold') });
    if (n('stored')) await invalidateUserCaches(who.uid);
    return json(res, 200, r);
  } catch (e) { await finishJob(run, 'failed', { error: String(e?.message || e).slice(0, 200) }); throw e; }
});
