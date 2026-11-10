import { json, handle, invalidateUserCaches } from '../_lib.js';
import { recordBalance } from '../_ingest.js';

// POST /api/balances {accountId, balance, asOf?, status?, note?}  (TR3-2.4). Appends to the balance history;
// a verified, newer bank balance also updates the legacy account columns. Agents or the owner; ?dryRun=1.
export default handle('wealth-balances', { methods: ['POST'] }, async ({ res, who, body, dryRun }) => {
  const r = await recordBalance(who.uid, body, { actor: who.actor, dryRun });
  if (r.stored) await invalidateUserCaches(who.uid);
  return json(res, r.stored ? 201 : 200, r);
});
