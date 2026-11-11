import { json } from './_lib.js';

// The only Vercel Function in this project. The Hobby plan allows at most 12 functions per deployment, so every
// /api/<name> URL is rewritten here (vercel.json) and dispatched to its handler in api/_routes/ (folders starting
// with "_" are not deployed as functions). URLs, methods and responses are unchanged.
// Imports are literal strings so the bundler includes each handler; each loads only when first used.
export const ROUTES = {
  'angel': () => import('./_routes/angel.js'),
  'auth': () => import('./_routes/auth.js'),
  'clear-session': () => import('./_routes/clear-session.js'),
  'dashboard': () => import('./_routes/dashboard.js'),
  'data-quality': () => import('./_routes/data-quality.js'),
  'health': () => import('./_routes/health.js'),
  'ledger': () => import('./_routes/ledger.js'),
  'planned-bills': () => import('./_routes/planned-bills.js'),
  'positions': () => import('./_routes/positions.js'),
  'providers': () => import('./_routes/providers.js'),
  'reconcile': () => import('./_routes/reconcile.js'),
  'refresh-market-prices': () => import('./_routes/refresh-market-prices.js'),
  'snapshot': () => import('./_routes/snapshot.js'),
  'stock-advisor': () => import('./_routes/stock-advisor.js'),
  // TSD Claude Plan 3
  'prices': () => import('./_routes/prices.js'),
  'email-imports': () => import('./_routes/email-imports.js'),
  'email-imports/seen': () => import('./_routes/email-imports.js'),
  'balances': () => import('./_routes/balances.js'),
  'holdings': () => import('./_routes/holdings.js'),
  'accounts': () => import('./_routes/accounts.js'),
  'account-detail': () => import('./_routes/account-detail.js'),
  'transaction-review': () => import('./_routes/transaction-review.js'),
  'interest': () => import('./_routes/interest.js'),
  'interest/rates': () => import('./_routes/interest.js'),
  'interest/run': () => import('./_routes/interest.js'),
  'interest/credits': () => import('./_routes/interest.js'),
  'obligations': () => import('./_routes/obligations.js'),
  'nightly': () => import('./_routes/nightly.js'),
  // TSD Claude Plan 4, Part A
  'rewards': () => import('./_routes/rewards.js'),
  'rewards/balances': () => import('./_routes/rewards.js'),
  'rewards/events': () => import('./_routes/rewards.js'),
  'rewards/programs': () => import('./_routes/rewards.js'),
  // Account splits (0019)
  'splits': () => import('./_routes/splits.js'),
  'splits/balances': () => import('./_routes/splits.js'),
  'splits/moves': () => import('./_routes/splits.js'),
};

// The route comes from the rewrite's __route parameter, or from the path when the router is called directly.
export function resolveRoute(rawUrl) {
  const url = new URL(rawUrl || '/', 'https://local');
  const fromQuery = url.searchParams.get('__route');
  const route = String(fromQuery ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  url.searchParams.delete('__route');
  return { route, cleanUrl: '/api/' + route + (url.search || '') };
}

export default async function handler(req, res) {
  const { route, cleanUrl } = resolveRoute(req.url);
  const load = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!load) return json(res, 404, { error: 'Not found' });
  req.url = cleanUrl;            // handlers see the original path and query
  req.route = route;             // shared modules (interest, email-imports) branch on the sub-path
  const mod = await load();
  return mod.default(req, res);
}
