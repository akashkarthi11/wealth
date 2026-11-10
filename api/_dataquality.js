// Data-quality report (TSD Claude Plan 3, Phase 4). One list of open issues with a stable id, severity,
// evidence and the action that resolves it. Checks read only; nothing here writes data.
import { sql, configStatus } from './_lib.js';
import { accountHierarchyRows } from './_queries.js';
import { valuePortfolio } from './_valuation.js';
import { jobActivity } from './_jobs.js';

const HOUR = 3600e3;
const ageH = (x, now) => (x ? (now - new Date(x).getTime()) / HOUR : Infinity);
const fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export async function collectIssues(uid, { db = sql, now = Date.now(), env = process.env } = {}) {
  const issues = [];
  const add = (id, severity, category, message, action, evidence = {}) => issues.push({ id, severity, category, message, action, evidence });

  // Account model valuation: missing prices/FX, stale or manual prices, stale or unverified balances.
  const model = valuePortfolio({ ...(await accountHierarchyRows(uid, db)), now });
  for (const e of model.totals.excluded) {
    const acc = model.accounts.find(a => a.id === e.accountId);
    add(`excluded:${e.accountId}:${e.symbol || 'balance'}`, 'high', 'not_counted',
      `${e.symbol || acc?.name || 'Balance'} is not counted in net worth (${e.reason.replace('_', ' ')})`,
      e.reason === 'missing_fx' ? 'Store a USD price with its USD→INR rate (price refresh)' : e.reason === 'missing_price' ? 'Store a price for this instrument' : 'Reconcile the balance',
      { account: acc?.name, amount: e.amount, currency: e.currency });
  }
  for (const a of model.accounts) {
    for (const h of a.holdings) {
      if (h.valuationStatus === 'stale') add(`stale_price:${h.instrumentId}`, 'medium', 'stale_price', `${h.symbol} price is older than 36 h`, 'Run the price refresh', { priceAsOf: h.priceAsOf, source: h.priceSource });
      if (h.valuationStatus === 'manual') add(`manual_price:${h.instrumentId}`, 'low', 'manual_price', `${h.symbol} uses a manually entered price (${h.priceSource})`, 'Let the refresh or hourly task store a market quote', { priceAsOf: h.priceAsOf });
      // Quantity sanity: market price far from the average cost usually means a wrong unit count.
      if (h.invested.amount > 0 && h.quantity > 0 && h.price.amount > 0) {
        const ratio = h.price.amount / (h.invested.amount / h.quantity);
        if (ratio < 0.5 || ratio > 2) add(`quantity_suspect:${h.instrumentId}`, 'high', 'quantity_suspect',
          `${h.symbol}: price ${fmt(h.price.amount)} is ${ratio < 1 ? 'far below' : 'far above'} the average cost ${fmt(h.invested.amount / h.quantity)} — the unit count may be wrong`,
          'Confirm the quantity from the broker statement', { quantity: h.quantity, invested: h.invested.amount, price: h.price.amount });
      }
    }
    if ((a.category === 'CASA' || a.category === 'LIABILITY') && a.balanceAsOf && ageH(a.balanceAsOf, now) > 48)
      add(`stale_balance:${a.id}`, 'medium', 'stale_balance', `${a.institution} · ${a.name} balance is from ${new Date(a.balanceAsOf).toISOString().slice(0, 10)}`, 'Record a current balance', { balanceAsOf: a.balanceAsOf });
    if (a.category === 'LIABILITY' && a.balance.amount == null)
      add(`no_balance:${a.id}`, 'low', 'no_balance', `${a.institution} · ${a.name} has no outstanding amount recorded`, 'Record the card outstanding (0 if nothing is owed)');
    if (a.subtype === 'provident_fund' && (a.balanceStatus !== 'verified' || a.balanceNote))
      add(`unverified_balance:${a.id}`, 'medium', 'unverified_balance', `${a.name} is ${a.balanceStatus || 'unverified'}${a.balanceNote ? ' — ' + a.balanceNote : ''}`, 'Verify the passbook value or accept it as reported');
    if (a.subtype === 'fixed_deposit')
      add(`fd_terms:${a.id}`, 'low', 'fd_terms_missing', `${a.institution} · ${a.name}: principal, booking date and maturity are not recorded`, 'Record the FD terms so interest can be calculated');
  }

  const [counts] = await db.query(`SELECT
      (SELECT count(*) FROM wealth_transactions WHERE user_id=$1 AND account_id IS NULL)::int AS unassigned,
      (SELECT count(*) FROM wealth_sync_issues WHERE occurred_at > now() - interval '24 hours')::int AS sync_issues`, [uid])
    .catch(async () => [{ unassigned: (await db.query(`SELECT count(*)::int n FROM wealth_transactions WHERE user_id=$1 AND account_id IS NULL`, [uid]))[0].n, sync_issues: 0 }]);
  if (counts.unassigned) add('unassigned_transactions', 'low', 'unassigned_transactions', `${counts.unassigned} transactions have no account`, 'Assign accounts where the source is known');
  if (counts.sync_issues) add('sync_issues', 'high', 'sync_issues', `${counts.sync_issues} legacy→v2 sync issue(s) in the last 24 h`, 'Check wealth_sync_issues and fix the source rows');

  const dupes = await db.query(`SELECT kind, amount::float8 AS amount, occurred_on::text AS day, description, array_agg(id ORDER BY created_at) AS ids
    FROM wealth_transactions WHERE user_id=$1 GROUP BY kind, amount, occurred_on, account_id, description HAVING count(*) > 1`, [uid]);
  for (const d of dupes) add(`duplicate_tx:${[...d.ids].sort().join(',')}`, 'medium', 'duplicate_candidate',
    `${d.ids.length}× ${d.kind} ₹${fmt(d.amount)} on ${d.day} (${d.description || 'no description'})`, 'Mark as duplicate or accept as genuine', { ids: d.ids });

  const rates = await db.query(`SELECT product_key, count(*)::int AS n FROM wealth_interest_rates WHERE effective_to IS NULL GROUP BY product_key HAVING count(*) > 1`);
  for (const r of rates) add(`open_rates:${r.product_key}`, 'medium', 'duplicate_rate_period', `${r.product_key} has ${r.n} open rate periods`, 'Close the older period (repair script ready)');

  const unlinked = await db.query(`SELECT a.id, a.bank_name, a.account_name FROM wealth_accounts a
    WHERE a.user_id=$1 AND a.status='active' AND a.subtype_code='savings'
      AND NOT EXISTS (SELECT 1 FROM wealth_interest_ledger l WHERE l.user_id=a.user_id AND l.account_key=a.account_key)`, [uid]);
  for (const a of unlinked) add(`interest_unlinked:${a.id}`, 'low', 'interest_unlinked', `${a.bank_name} · ${a.account_name} has no interest product or rate`, 'Link an interest product and rate, or accept as non-interest-bearing');

  // Jobs and configuration.
  const act = await jobActivity(db);
  const refresh = act.runs.find(r => r.job === 'price-refresh');
  if (!refresh) add('job:price-refresh:never', 'medium', 'job_stale', 'The daily price refresh has never run', env.CRON_SECRET ? 'Check the Vercel cron for /api/refresh-market-prices' : 'Add CRON_SECRET in Vercel (Production)');
  else if (ageH(refresh.started_at, now) > 36) add('job:price-refresh:stale', 'medium', 'job_stale', `Last price refresh was ${Math.round(ageH(refresh.started_at, now))} h ago`, 'Check the Vercel cron');
  for (const job of act.failingTwice) add(`job:${job}:failing`, 'high', 'job_failing', `${job} failed on its last two runs`, 'Check wealth_job_runs.summary for the error');
  if (act.external.advisor_last && ageH(act.external.advisor_last, now) > 3)
    add('job:advisor:silent', 'low', 'job_stale', `No Stock Advisor report for ${Math.round(ageH(act.external.advisor_last, now))} h`, 'Check the hourly task');
  const cfg = configStatus(env);
  if (cfg.environment === 'production' && !cfg.cronSecret) add('config:cron_secret', 'medium', 'configuration', 'CRON_SECRET is not set: the daily price refresh is rejected', 'Add CRON_SECRET in Vercel (Production)');

  // Accepted issues are kept but not counted as open.
  const accepted = new Map((await db.query(`SELECT issue_id, reason, accepted_at FROM wealth_data_quality_acceptances WHERE user_id=$1`, [uid]).catch(() => []))
    .map(r => [r.issue_id, r]));
  for (const i of issues) { const a = accepted.get(i.id); i.accepted = !!a; if (a) { i.acceptedReason = a.reason; i.acceptedAt = a.accepted_at; } }
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((x, y) => (x.accepted - y.accepted) || (order[x.severity] - order[y.severity]) || x.id.localeCompare(y.id));
  const open = s => issues.filter(i => !i.accepted && i.severity === s).length;
  return { generatedAt: new Date(now).toISOString(), open: { high: open('high'), medium: open('medium'), low: open('low') }, issues };
}
