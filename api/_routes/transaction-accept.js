import { json, handle, invalidateUserCaches } from '../_lib.js';
import { pendingTransactions, acceptTransaction, dismissTransaction } from '../_accept.js';

// GET  /api/transaction-accept                                   transactions waiting for review, with the balance after Accept and matching offers
// POST /api/transaction-accept {action:'accept', transactionId}   writes the new balance on the source account, returns matching offers
// POST /api/transaction-accept {action:'dismiss', transactionId}  keeps the transaction, leaves the balance alone
export default handle('wealth-transaction-accept', { methods: ['GET', 'POST'], auth: { ingest: false, user: true } }, async ({ req, res, who, body }) => {
  if (req.method === 'GET') return json(res, 200, { pending: await pendingTransactions(who.uid) });
  let r;
  if (body.action === 'accept') r = await acceptTransaction(who.uid, body, { actor: who.actor });
  else if (body.action === 'dismiss') r = await dismissTransaction(who.uid, body, { actor: who.actor });
  else return json(res, 400, { error: 'action must be accept or dismiss' });
  await invalidateUserCaches(who.uid);
  return json(res, 200, r);
});
