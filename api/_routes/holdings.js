import { json, handle, invalidateUserCaches } from '../_lib.js';
import { updateHolding } from '../_ingest.js';

// PUT /api/holdings {accountId, instrumentId, quantity, investedValue?, asOf?, evidence, releasePriceHold?}
// Quantity correction with evidence (TR3-1.1 / TR3-2.4). Owner only: agents never change quantities. ?dryRun=1.
export default handle('wealth-holdings', { methods: ['PUT'], auth: { ingest: false, user: true } }, async ({ res, who, body, dryRun }) => {
  const r = await updateHolding(who.uid, body, { actor: who.actor, dryRun });
  if (!dryRun) await invalidateUserCaches(who.uid);
  return json(res, 200, r);
});
