import { sql, schema, json, body, sessionUser, check, invalidateUserCaches, rateLimit, rateCount, rateReset } from '../_lib.js';
import { importAll } from '../_upload.js';
import { saveScreenshot, readScreenshot, listScreenshots, removeScreenshot, userAccounts, readingConfigured } from '../_screenshots.js';

// GET    /api/uploads                 — the signed-in user's screenshots (no images): waiting, read, failed
// DELETE /api/uploads?id=<uuid>       — take back a screenshot that failed
// POST   /api/uploads {password, transactions[], accounts[], lending[], investments[]}  — save sheet rows as the user's own data
// POST   /api/uploads {password, screenshot:{name, data(base64)}, accountId?}           — read a payment screenshot with the vision model; payments wait as pending
// The account password is required on every upload (nothing is remembered), and wrong passwords are rate limited.
const WINDOW = 15 * 60, LIMIT = 5;
export default async function handler(req, res) {
  try {
    const uid = await sessionUser(req); if (!uid) return json(res, 401, { error: 'Sign in required' });
    await schema();
    // The Gateway key, or else the project's own Vercel token (OIDC) that a deployed function receives; neither is ever sent to the browser.
    const aiEnv = { ...process.env, AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || String(req.headers['x-vercel-oidc-token'] || '') };
    if (req.method === 'GET') return json(res, 200, { screenshots: await listScreenshots(uid), accounts: await userAccounts(uid), reading: readingConfigured(aiEnv) });
    if (req.method === 'DELETE') {
      const r = await removeScreenshot(uid, new URL(req.url, 'https://local').searchParams.get('id'));
      return json(res, 200, r);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const key = 'upload:pw:' + uid;
    if ((await rateCount(key)) >= LIMIT) { res.setHeader('Retry-After', String(WINDOW)); return json(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes and try again.' }); }
    const b = await body(req, 4400000);
    const [u] = await sql.query('SELECT password_hash FROM wealth_users WHERE id=$1', [uid]);
    if (!u || !check(String(b.password || ''), u.password_hash)) {
      await rateLimit(key, LIMIT, WINDOW);
      return json(res, 403, { error: 'Password is incorrect.' });
    }
    await rateReset(key);
    if (b.screenshot) {
      if (!readingConfigured(aiEnv)) return json(res, 503, { error: 'Reading screenshots is not set up yet. Ask the owner to add the AI Gateway key.' });
      const saved = await saveScreenshot(uid, b.screenshot);
      const r = await readScreenshot(uid, saved.id, { chosenAccountId: b.accountId || null, env: aiEnv });
      if (r.added) await invalidateUserCaches(uid);
      return json(res, 200, r);
    }
    const r = await importAll(uid, { transactions: b.transactions ?? b.rows, accounts: b.accounts, lending: b.lending, investments: b.investments }, { actor: 'user' });
    if (r.added) await invalidateUserCaches(uid);
    return json(res, 200, r);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message, details: e.details });
    console.error('[wealth-uploads]', e?.message || e);
    return json(res, 500, { error: e?.message === 'Request too large' ? 'The file is too large.' : 'Unable to upload.' });
  }
}
