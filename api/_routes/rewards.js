import { json, handle, invalidateUserCaches } from '../_lib.js';
import { rewardsOverview, recordRewardBalance, recordRewardEvent, upsertRewardProgram } from '../_rewards.js';

// GET  /api/rewards            programs, latest balances, ₹ value where a rate is known, cashback from transactions (owner)
// POST /api/rewards/balances   new balance from a screenshot or statement (owner or agent; ?dryRun=1)
// POST /api/rewards/events     earned / redeemed / expired / adjusted (owner or agent; ?dryRun=1)
// POST /api/rewards/programs   create a program, or set its ₹ rate (with source) and redemption details (owner or agent)
const AUTH = { 'rewards': { ingest: false } };

export default handle('wealth-rewards', { methods: ['GET', 'POST'], auth: req => AUTH[req.route] || {} }, async ({ req, res, who, body, dryRun }) => {
  const route = req.route || 'rewards';
  if (route === 'rewards') return req.method === 'GET' ? json(res, 200, await rewardsOverview(who.uid)) : json(res, 405, { error: 'Method not allowed' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const fn = { 'rewards/balances': recordRewardBalance, 'rewards/events': recordRewardEvent, 'rewards/programs': upsertRewardProgram }[route];
  if (!fn) return json(res, 404, { error: 'Not found' });
  const r = await fn(who.uid, body, { actor: who.actor, dryRun });
  if (r.stored) await invalidateUserCaches(who.uid);
  return json(res, r.stored ? 201 : 200, r);
});
