import { collectFincruxFinancials, releaseAbandonedReservations, clearFincruxDailyUsageMemory } from './stock-advisor-fincrux.js';
import { collectNseNewsBatch, NSE_FEED_LABELS } from './stock-advisor-live-evidence.js';
import { collectMutualFundEvidence } from './stock-advisor-mfapi.js';
import { collectTejHqEquityEvidence } from './stock-advisor-tejhq.js';
import { collectNseXbrlFinancialStatement } from './stock-advisor-nse-xbrl.js';
import { collectYahooFinancials } from './stock-advisor-yahoo-financials.js';
import { loadFincruxApiKeys } from './provider-api-keys.js';
export { cleanNseFeedItemMatches } from './stock-advisor-live-evidence.js';

// Stock Advisor data collection, as small TASKS. The scheduled job puts one task per provider call on the job queue (api/_lib/job-queue.js), so
// the work is shared over as many function calls as it needs. runStockAdvisorDataCollection runs the same tasks one after another inside one
// call (used by the direct route); both fold the task results into the same summary.
const CALL_MS = 13000; // the slowest provider call waits 12 s
const XBRL_CALL_MS = 26000; // three audited NSE requests, each with an 8 s timeout
export const TASKS = Object.freeze({
  nse: { provider: 'NSE RSS', priority: 40 },
  fund: { provider: 'MFAPI.in', priority: 41, name: 'Fund NAV' },
  equity: { provider: 'TejHQ', priority: 42, name: 'Prices and technical indicators' },
  nse_xbrl: { provider: 'NSE XBRL', priority: 43, name: 'Filed financial statements' },
  yahoo_financials: { provider: 'Yahoo Finance fundamentals', priority: 44, name: 'Secondary quarterly figures (unverified)' },
  fincrux: { provider: 'Fincrux', priority: 45, name: 'Secondary financial data (unverified)' },
  fincrux_skip: { provider: 'Fincrux', priority: 45, name: 'Secondary financial data (unverified)' },
  verify: { provider: 'Fincrux', priority: 46, name: 'Legacy verification disabled' },
});
const DEFERRABLE = new Set(['fund', 'equity', 'fincrux', 'nse_xbrl', 'yahoo_financials']);

const errorText = e => typeof e === 'string' ? e : e && typeof e === 'object' ? [e.ticker, e.feed, e.error].filter(Boolean).join(': ') : String(e ?? '');
const note = r => String(r?.reason || r?.error || (Array.isArray(r?.errors) && r.errors.length ? r.errors.map(errorText).join('; ') : '') || '').slice(0, 180);
const obj = v => (typeof v === 'string' ? JSON.parse(v) : v) || {};
const slim = i => ({ id: i.id, asset_class: i.asset_class, symbol: i.symbol, name: i.name, price_source_symbol: i.price_source_symbol });

export async function startCollectionRun(db) {
  const [run] = await db.query('INSERT INTO wealth_stock_advisor_data_collection_runs(status) VALUES(\'running\') RETURNING id');
  return run.id;
}

// Active holdings with a symbol and a price-source symbol, the stocks collected longest ago first (so a run that does not get through all of
// them never starves the same stocks).
async function loadXbrlInstruments(db) {
  return db.query(`SELECT DISTINCT i.id,i.asset_class,i.symbol,i.name,i.price_source_symbol
   FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
   WHERE h.status='active' AND i.asset_class='indian_equity' AND i.symbol IS NOT NULL
   ORDER BY i.symbol LIMIT 250`);
}

async function loadInstruments(db) {
  const instruments = await db.query(`SELECT DISTINCT i.id,i.asset_class,i.symbol,i.name,i.price_source_symbol
   FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
   WHERE h.status='active' AND i.symbol IS NOT NULL AND i.price_source_symbol IS NOT NULL
   ORDER BY i.symbol LIMIT 250`);
  const lastRows = await db.query(`SELECT upper(ticker) AS ticker,max(retrieved_at) AS at FROM wealth_stock_advisor_research_sources
   WHERE run_id IS NULL AND (publisher LIKE 'TejHQ%' OR publisher='MFAPI.in') GROUP BY 1`);
  const lastBy = new Map((lastRows || []).map(r => [r.ticker, r.at ? new Date(r.at).getTime() : 0]));
  const oldestFirst = (a, b) => (lastBy.get(String(a.symbol).toUpperCase()) || 0) - (lastBy.get(String(b.symbol).toUpperCase()) || 0) || String(a.symbol).localeCompare(String(b.symbol));
  return {
    instruments,
    funds: instruments.filter(i => i.asset_class === 'indian_mutual_fund').sort(oldestFirst),
    equities: instruments.filter(i => i.asset_class === 'indian_equity').sort(oldestFirst),
  };
}

// The tasks of one collection, in the order they should run. Fincrux is limited to five requests a day, so only that many are planned.
export async function planCollection(db) {
  const { instruments, funds, equities } = await loadInstruments(db);
  const xbrlEquities = await loadXbrlInstruments(db);
  const tasks = [];
  const add = (task, payload = {}) => tasks.push({ task, payload, priority: TASKS[task].priority, min_budget_ms: task === 'nse_xbrl' ? XBRL_CALL_MS : task === 'fincrux_skip' ? 1000 : CALL_MS });
  for (const feed of NSE_FEED_LABELS) if (equities.length) add('nse', { feed });
  for (const f of funds) add('fund', { instrument: slim(f) });
  for (const e of equities) add('equity', { instrument: slim(e) });
  // XBRL covers every active Indian equity with a symbol, even if the price-source symbol is not configured.
  // Duplicate instrument rows for the same ticker share one NSE filing and therefore one queue item.
  const xbrlHoldings = [...new Map(xbrlEquities.map(e => [String(e.symbol || '').toUpperCase(), e])).values()];
  for (const e of xbrlHoldings) add('nse_xbrl', { instrument: slim(e) });
  // Context figures for the analysts. No key and no quota, and never promoted to verified.
  for (const e of xbrlHoldings) add('yahoo_financials', { instrument: slim(e) });
  if (equities.length) {
    // Free any abandoned placeholder first, so the day's five requests can reach tickers that are otherwise locked out.
    const released = await releaseAbandonedReservations(db).catch(() => []);
    if (released.length) tasks.push({ task: 'fincrux_skip', payload: { reason: 'Released ' + released.length + ' abandoned reservation(s) so these tickers can be requested again: ' + released.join(', ') + '.' }, priority: TASKS.fincrux_skip.priority, min_budget_ms: 1000 });
    const fincruxKeys = await loadFincruxApiKeys(db);
    if (fincruxKeys.length) {
      const [quota] = await db.query(`SELECT count(*)::int AS used
       FROM wealth_stock_advisor_research_sources
       WHERE publisher='Fincrux'
         AND retrieved_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
         AND retrieved_at < ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata')`);
      const remaining = Math.max(0, (5 * fincruxKeys.length) - Number(quota?.used || 0));
      if (remaining) {
        const recent = await db.query(`SELECT upper(ticker) AS ticker,max(retrieved_at) AS last_retrieved
         FROM wealth_stock_advisor_research_sources
         WHERE publisher='Fincrux' AND source_type='financial_statement'
         GROUP BY upper(ticker)`);
        const lastByTicker = new Map(recent.map(row => [row.ticker, row.last_retrieved ? Date.parse(row.last_retrieved) : 0]));
        const candidates = [...equities].sort((a, b) => (lastByTicker.get(String(a.symbol).toUpperCase()) || 0) - (lastByTicker.get(String(b.symbol).toUpperCase()) || 0));
        for (const c of candidates.slice(0, remaining)) add('fincrux', { instrument: slim(c) });
      } else add('fincrux_skip', { reason: 'All configured Fincrux accounts have used their combined daily allowance (IST).' });
    } else add('fincrux_skip', { reason: 'No Fincrux API keys are configured in Provider Health or the environment; no request attempted.' });
  }
  return { instruments: instruments.length, tasks };
}

// Run ONE task. Never throws: a failure comes back as status 'failed' so one stock cannot stop the others.
export async function runCollectionTask(db, task, payload = {}, { deadlineAt = null } = {}) {
  const meta = TASKS[task], i = payload?.instrument;
  if (!meta) return { provider: 'unknown', name: String(task), status: 'failed', note: 'Unknown task.', detail: [] };
  const base = { provider: meta.provider, ticker: i?.symbol, name: meta.name };
  try {
    if (task === 'nse') {
      const { equities } = await loadInstruments(db);
      const feedLabels = payload.feed ? [payload.feed] : null;
      const news = await collectNseNewsBatch({ instruments: equities, db, deadlineAt, feedLabels });
      const seen = (news.feeds || []).map(f => f.items + ' read, ' + f.matched + ' matched').join('; ');
      return { ...base, name: (payload.feed || 'All feeds') + ' · ' + equities.length + ' stocks' + (seen ? ' · ' + seen : ''), status: news.status, note: note(news), feeds_checked: news.feeds_checked, stored: news.stored,
        detail: [{ provider: news.provider, status: news.status, feeds_checked: news.feeds_checked, stored: news.stored, errors: news.errors }, ...news.results] };
    }
    if (task === 'fund') {
      const r = await collectMutualFundEvidence({ ticker: i.symbol, name: i.name, schemeCode: i.price_source_symbol, instrumentId: i.id, runId: null, db });
      return { ...base, status: r.status, note: note(r), detail: [r] };
    }
    if (task === 'equity') {
      const r = await collectTejHqEquityEvidence({ ticker: i.symbol, name: i.name, db });
      return { ...base, status: r.status, note: note(r), detail: [r] };
    }
    if (task === 'yahoo_financials') {
      const r = await collectYahooFinancials({ instrument: i, db });
      return { ...base, status: r.status, note: note(r), detail: [r] };
    }
    if (task === 'fincrux') {
      const r = await collectFincruxFinancials({ instrument: i, db, manual: payload.manual === true });
      return { ...base, status: r.status, note: note(r), detail: [r] };
    }
    if (task === 'fincrux_skip') return { ...base, status: 'skipped', note: payload.reason, detail: [{ provider: 'Fincrux', status: 'skipped', reason: payload.reason }] };
    if (task === 'nse_xbrl') {
      const r = await collectNseXbrlFinancialStatement({ instrument: i, db });
      return { ...base, status: r.status, note: note(r), detail: [{ provider: 'NSE XBRL', ...r }] };
    }
    if (task === 'verify') return { ...base, status: 'skipped', note: 'Legacy Fincrux period verification is disabled; Fincrux remains unverified.', detail: [] };
    return { ...base, status: 'failed', note: 'Task implementation is missing.', detail: [] };
  } catch (e) {
    const message = String(e?.message || e).slice(0, 180);
    const status = task === 'equity' ? 'market_data_failed' : 'failed';
    return { ...base, status, note: message, detail: [{ ticker: i?.symbol, status, provider: meta.provider, error: message }] };
  }
}

export const newSummary = () => ({ instruments: 0, nav_updated: 0, market_data_updated: 0, financials_unverified: 0, financials_verified: 0, financials_missing: 0, announcements: 0, failed: 0, skipped: 0, feeds: 0, results: [], steps: [] });

// Add one task result to the summary counters.
export function foldTaskResult(summary, task, r) {
  summary.results.push(...(r.detail || []));
  if (task === 'nse') { summary.feeds += r.feeds_checked || 0; summary.announcements += r.stored || 0; if (['unavailable', 'partial', 'failed'].includes(r.status)) summary.failed++; }
  else if (task === 'fund') { if (r.status === 'ok') summary.nav_updated++; else if (r.status === 'unavailable' || r.status === 'failed') summary.failed++; else summary.skipped++; }
  else if (task === 'equity') { if (r.status === 'ok') summary.market_data_updated++; else if (r.status === 'unavailable' || r.status === 'market_data_failed') summary.failed++; }
  else if (task === 'nse_xbrl') { if (r.status === 'verified' || r.status === 'already_present') summary.financials_verified++; else if (['failed','unparsed','period_mismatch','ticker_mismatch','announcement_company_mismatch'].includes(r.status)) summary.failed++; else { summary.financials_missing++; summary.skipped++; } }
  else if (task === 'yahoo_financials' || task === 'fincrux') { if (r.status === 'stored_unverified') summary.financials_unverified++; else if (r.status === 'failed') summary.failed++; else summary.skipped++; }
  else if (task === 'verify') summary.skipped++;
}

export function runStatus(summary) {
  const successful = summary.nav_updated + summary.market_data_updated + summary.financials_unverified + summary.financials_verified + summary.announcements;
  const incomplete = summary.failed + (summary.skipped_for_time || 0) + (summary.financials_missing || 0);
  return incomplete ? (successful ? 'partial' : 'failed') : 'succeeded';
}

// One line per task for the AI data page. A queue item that has not run yet is 'queued'.
export function stepOf(item) {
  const meta = TASKS[item.task] || {}, i = obj(item.payload).instrument, r = obj(item.result);
  const status = item.status === 'pending' ? 'queued' : item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : String(r.status || 'ok');
  const started = item.started_at ? new Date(item.started_at).toISOString() : null;
  const ms = item.started_at && item.finished_at ? Math.max(0, new Date(item.finished_at) - new Date(item.started_at)) : undefined;
  return { provider: meta.provider || item.handler_key, ticker: i?.symbol, name: r.name || meta.name || '', status, note: String(r.note || item.error || '').slice(0, 180), started_at: started, ms };
}

// Summary counters from the queue items of one run. Items that have not finished are left out.
export function summarizeItems(items, { instruments = 0 } = {}) {
  const summary = newSummary();
  summary.instruments = instruments;
  for (const item of items) {
    if (!TASKS[item.task]) continue;
    if (item.status === 'done') foldTaskResult(summary, item.task, obj(item.result));
    else if (item.status === 'failed') foldTaskResult(summary, item.task, { ...stepOf(item), detail: [] , status: item.task === 'equity' ? 'market_data_failed' : 'failed' });
  }
  return summary;
}

// When the last task of a run has finished, write the run's summary and status. Safe to call again: only a run that is still 'running' changes.
export async function finalizeCollectionRun(db, runId) {
  if (!runId) return null;
  const items = await db.query(`SELECT handler_key,task,status,payload,result,error,started_at,finished_at FROM wealth_job_queue
    WHERE payload->>'collection_run_id'=$1 ORDER BY priority,created_at,id`, [runId]);
  if (!items.length || items.some(x => x.status === 'pending' || x.status === 'running')) return null;
  clearFincruxDailyUsageMemory();
  const [run] = await db.query('SELECT started_at,summary FROM wealth_stock_advisor_data_collection_runs WHERE id=$1 AND status=\'running\'', [runId]);
  if (!run) return null;
  const summary = summarizeItems(items, { instruments: Number(obj(run.summary).instruments || 0) });
  summary.steps = items.map(stepOf);
  summary.work_ms = summary.steps.reduce((s, x) => s + (x.ms || 0), 0);
  summary.duration_ms = Date.now() - new Date(run.started_at).getTime();
  const status = runStatus(summary);
  const done = await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=$2,summary=$3::jsonb WHERE id=$1 AND status=\'running\' RETURNING id', [runId, status, JSON.stringify(summary)]);
  return done.length ? { status, summary } : null;
}

// The whole collection inside ONE function call, task by task (the direct route). Every call is timed and written to the run as it finishes.
export async function runStockAdvisorDataCollection(db, { deadlineAt: givenDeadline } = {}) {
  const runId = await startCollectionRun(db);
  const summary = newSummary();
  const began = Date.now();
  // The function is stopped at 60 seconds: stop starting provider calls when too little time is left and say so.
  const deadlineAt = Number.isFinite(givenDeadline) ? givenDeadline : began + 52000;
  const saveSteps = () => db.query('UPDATE wealth_stock_advisor_data_collection_runs SET summary=summary||jsonb_build_object(\'steps\',$2::jsonb) WHERE id=$1', [runId, JSON.stringify(summary.steps)]).catch(() => {});
  try {
    const plan = await planCollection(db);
    summary.instruments = plan.instruments;
    for (const t of plan.tasks) {
      const meta = TASKS[t.task], i = t.payload?.instrument, at = Date.now();
      const step = { provider: meta.provider, ticker: i?.symbol, name: meta.name || '', status: 'running', started_at: new Date(at).toISOString() };
      const minimumBudget = t.task === 'nse_xbrl' ? XBRL_CALL_MS : CALL_MS;
      if (DEFERRABLE.has(t.task) && deadlineAt - Date.now() < minimumBudget) {
        summary.skipped_for_time = (summary.skipped_for_time || 0) + 1;
        summary.steps.push({ ...step, status: 'skipped', note: 'Time limit reached; collected first in the next run.', ms: 0 });
        continue;
      }
      summary.steps.push(step); await saveSteps();
      const r = await runCollectionTask(db, t.task, t.payload, { deadlineAt });
      step.status = String(r.status || 'ok'); step.note = r.note || ''; step.ms = Date.now() - at; if (t.task === 'nse') step.name = r.name;
      foldTaskResult(summary, t.task, r);
      await saveSteps();
    }
    const status = runStatus(summary);
    summary.duration_ms = Date.now() - began;
    await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=$2,summary=$3::jsonb WHERE id=$1', [runId, status, JSON.stringify(summary)]);
    return { run_id: runId, status, ...summary };
  } catch (error) {
    summary.duration_ms = Date.now() - began;
    await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=\'failed\',error=$2,summary=$3::jsonb WHERE id=$1', [runId, String(error?.message || error).slice(0, 500), JSON.stringify(summary)]).catch(() => {});
    throw error;
  }
}
