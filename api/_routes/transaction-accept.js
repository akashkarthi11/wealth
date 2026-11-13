import { json, handle, invalidateUserCaches } from '../_lib.js';
import { pendingTransactions, acceptTransaction, dismissTransaction, applyOffersToTransaction } from '../_accept.js';

// GET  /api/transaction-accept                                   transactions waiting for review, with the balance after Accept and matching offers
// POST /api/transaction-accept {action:'accept', transactionId, applyOfferIds?}  writes the new balance on the source account and applies the matching offers (the automatic ones, or exactly applyOfferIds)
// POST /api/transaction-accept {action:'apply_offers', transactionId, applyOfferIds?}  apply offers to a payment that was already accepted
// POST /api/transaction-accept {action:'dismiss', transactionId}  keeps the transaction, leaves the balance alone
export default handle('wealth-transaction-accept', { methods: ['GET', 'POST'], auth: { ingest: false, user: true } }, async ({ req, res, who, body }) => {
  if (req.method === 'GET') return json(res, 200, { pending: await pendingTransactions(who.uid) });
  let r;
  if (body.action === 'accept') r = await acceptTransaction(who.uid, body, { actor: who.actor });
  else if (body.action === 'dismiss') r = await dismissTransaction(who.uid, body, { actor: who.actor });
  else if (body.action === 'apply_offers') r = await applyOffersToTransaction(who.uid, body, { actor: who.actor });
  else return json(res, 400, { error: 'action must be accept, dismiss or apply_offers' });
  await invalidateUserCaches(who.uid);
  return json(res, 200, r);
});
