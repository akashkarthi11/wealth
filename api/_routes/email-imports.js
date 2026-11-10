import { json, handle, invalidateUserCaches } from '../_lib.js';
import { recordEmailImport, seenMessages } from '../_ingest.js';

// POST /api/email-imports {messageId, outcome, transactions?}   record one reviewed email (idempotent on messageId)
// GET  /api/email-imports/seen?ids=a,b,c                         which message ids are already processed
// (TR3-2.2 / TR3-2.3). Agents (Bearer WEALTH_INGEST_SECRET) or the owner. POST accepts ?dryRun=1.
export default handle('wealth-email-imports', { methods: ['GET', 'POST'] }, async ({ req, res, who, q, body, dryRun }) => {
  if (req.method === 'GET') {
    if (req.route !== 'email-imports/seen') return json(res, 404, { error: 'Use GET /api/email-imports/seen?ids=…' });
    return json(res, 200, await seenMessages(who.uid, q.get('ids')));
  }
  const r = await recordEmailImport(who.uid, body, { actor: who.actor, dryRun });
  if (r.body.importStatus === 'imported') await invalidateUserCaches(who.uid);
  return json(res, r.status, r.body);
});
