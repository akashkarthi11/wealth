import { json, handle } from '../_lib.js';
import { obligationsByAccount } from '../_queries.js';

// GET /api/obligations — recurring obligations grouped by account, each with its next payment occurrence (TR3-5.1).
// One row per obligation, so the same payment never appears twice. Owner only.
export default handle('wealth-obligations', { methods: ['GET'], auth: { ingest: false, user: true } },
  async ({ res, who }) => json(res, 200, await obligationsByAccount(who.uid)));
