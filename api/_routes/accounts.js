import { json, handle, invalidateUserCaches } from '../_lib.js';
import { createAccount, setFdTerms } from '../_ingest.js';

// POST  /api/accounts {subtype, institution, name, maskedIdentifier?, currency?, fdTerms?}        new account (TR3-2.4)
// PATCH /api/accounts {accountId, fdTerms:{principal, bookedOn, maturityOn, payout, compounding}}  FD terms (TR3-1.4)
// Owner only.
export default handle('wealth-accounts', { methods: ['POST', 'PATCH'], auth: { ingest: false, user: true } }, async ({ req, res, who, body }) => {
  const r = req.method === 'POST' ? await createAccount(who.uid, body, { actor: who.actor }) : await setFdTerms(who.uid, body, { actor: who.actor });
  await invalidateUserCaches(who.uid);
  return json(res, req.method === 'POST' ? 201 : 200, r);
});
