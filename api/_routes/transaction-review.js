import { json, handle, invalidateUserCaches } from '../_lib.js';
import { suggestAccounts, assignAccounts, markDuplicate } from '../_ingest.js';

// GET  /api/transaction-review                                   account suggestions for unassigned transactions (TR3-1.8)
// POST /api/transaction-review {action:'assign', assignments:[{transactionId, accountId}]}
// POST /api/transaction-review {action:'mark_duplicate', transactionId, duplicateOf}   duplicateOf null = unmark (TR3-1.3)
// Owner only. Marked duplicates stay stored and are left out of totals.
export default handle('wealth-transaction-review', { methods: ['GET', 'POST'], auth: { ingest: false, user: true } }, async ({ req, res, who, body }) => {
  if (req.method === 'GET') return json(res, 200, await suggestAccounts(who.uid));
  let r;
  if (body.action === 'assign') r = await assignAccounts(who.uid, body.assignments, { actor: who.actor });
  else if (body.action === 'mark_duplicate') r = await markDuplicate(who.uid, body, { actor: who.actor });
  else return json(res, 400, { error: 'action must be assign or mark_duplicate' });
  await invalidateUserCaches(who.uid);
  return json(res, 200, r);
});
