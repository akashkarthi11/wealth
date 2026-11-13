import { json, handle, invalidateUserCaches } from '../_lib.js';
import { listEarnings, setEarningStatus } from '../_offers.js';

// GET  /api/offer-earnings   what offers earned on the user's payments: money still to arrive (with a suggested credit), money received, points
// POST /api/offer-earnings {action:'received', earningId, creditedTransactionId?, creditedOn?}  the cashback arrived (optionally link the income transaction that carried it)
// POST /api/offer-earnings {action:'expected', earningId}   reopen
// POST /api/offer-earnings {action:'cancel', earningId}    remove (kept as cancelled, no longer counts toward limits)
const STATUS = { received: 'received', expected: 'expected', cancel: 'cancelled' };
export default handle('wealth-offer-earnings', { methods: ['GET', 'POST'], auth: { ingest: false, user: true } }, async ({ req, res, who, body }) => {
  if (req.method === 'GET') return json(res, 200, await listEarnings(who.uid));
  const status = STATUS[body.action];
  if (!status) return json(res, 400, { error: 'action must be received, expected or cancel' });
  const r = await setEarningStatus(who.uid, { earningId: body.earningId, status, creditedTransactionId: body.creditedTransactionId || null, creditedOn: body.creditedOn || null }, { actor: who.actor });
  await invalidateUserCaches(who.uid);
  return json(res, 200, r);
});
