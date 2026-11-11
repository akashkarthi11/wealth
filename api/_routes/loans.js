import { json, handle, invalidateUserCaches, cachedValue, sendCached } from '../_lib.js';
import { loansOverview, savePerson, addPersonEntry, createSplit, cancelSplit } from '../_loans.js';

// Money lent and bill splits (TSD Claude Plan 4, Part B). Owner only — personal money is sensitive.
// GET  /api/loans                 people with what each owes, split bills, suggestions to review
// POST /api/loans/people          add a person, or update (personId): due date, rate %, status, note, name
// POST /api/loans/entries         link transfers to a person (lent / paid back) or add a cash amount
// POST /api/loans/splits          split a bill (equal or amounts per person, GST shared), optionally from a transaction
// POST /api/loans/splits/cancel   cancel a split (kept, no longer counted)
// Every POST takes ?dryRun=1.
const OWNER = { ingest: false };
const POSTS = { 'loans/people': savePerson, 'loans/entries': addPersonEntry, 'loans/splits': createSplit, 'loans/splits/cancel': cancelSplit };

export default handle('wealth-loans', { methods: ['GET', 'POST'], auth: () => OWNER }, async ({ req, res, who, body, dryRun }) => {
  const route = req.route || 'loans';
  if (route === 'loans') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // interest and overdue move with the day
    return sendCached(res, await cachedValue(req, who.uid, 'loans', () => loansOverview(who.uid), { variant: day }));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const fn = POSTS[route];
  if (!fn) return json(res, 404, { error: 'Not found' });
  const r = await fn(who.uid, body, { actor: who.actor, dryRun });
  if (r.stored) await invalidateUserCaches(who.uid);
  return json(res, r.stored ? 201 : 200, r);
});
