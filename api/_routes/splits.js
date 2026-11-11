import { json, handle, isUuid } from '../_lib.js';
import { splitsForAccount, recordSplitBalance, recordSplitMove } from '../_splits.js';

// GET  /api/splits?accountId=…   splits of one account with estimated balances (owner)
// POST /api/splits/balances      balance from a screenshot (owner or agent; ?dryRun=1)
// POST /api/splits/moves         + into / − out of a split, optionally linked to a transaction (owner or agent; ?dryRun=1)
const AUTH = { 'splits': { ingest: false } };

export default handle('wealth-splits', { methods: ['GET', 'POST'], auth: req => AUTH[req.route] || {} }, async ({ req, res, who, q, body, dryRun }) => {
  const route = req.route || 'splits';
  if (route === 'splits') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const accountId = q.get('accountId');
    if (!isUuid(accountId)) return json(res, 400, { error: 'accountId must be an account id' });
    return json(res, 200, { splits: await splitsForAccount(who.uid, accountId) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const fn = { 'splits/balances': recordSplitBalance, 'splits/moves': recordSplitMove }[route];
  if (!fn) return json(res, 404, { error: 'Not found' });
  const r = await fn(who.uid, body, { actor: who.actor, dryRun });
  return json(res, r.stored ? 201 : 200, r);
});
