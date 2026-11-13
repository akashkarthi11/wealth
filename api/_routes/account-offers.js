import { json, handle } from '../_lib.js';
import { listOffers, saveOffer, deleteOffer, undoLastUse } from '../_offers.js';

// GET    /api/account-offers          the user's offers and accounts
// POST   /api/account-offers {id?, accountId, title, merchants, benefitType, benefitValue, ...}  add (no id) or change an offer
// POST   /api/account-offers {action:'undo_use', offerId}   undo the latest recorded use of an offer
// DELETE /api/account-offers?id=...   remove an offer
export default handle('wealth-account-offers', { methods: ['GET', 'POST', 'DELETE'], auth: { ingest: false, user: true } }, async ({ req, res, who, body, q }) => {
  if (req.method === 'GET') return json(res, 200, await listOffers(who.uid));
  if (req.method === 'DELETE') return json(res, 200, await deleteOffer(who.uid, q.get('id')));
  if (body.action === 'undo_use') return json(res, 200, await undoLastUse(who.uid, body.offerId));
  return json(res, 200, await saveOffer(who.uid, body));
});
