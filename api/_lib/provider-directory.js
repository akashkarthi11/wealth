/**
 * The one list of outside providers this app calls, built live from the database and from environment presence
 * checks — never a second, hand-kept copy. Provider Health and API usage both render this same list, so they cannot
 * drift apart the way they had: Provider Health's own hardcoded six-provider array (in stock-advisor.js) did not know
 * about Agent web or Web search at all, and read only env-var presence where API usage already had real usage counts
 * from the database (owner's request 2026-11-24: "provider health data, api usage all should come from db").
 *
 * Nothing here ever reads or returns a key's value — only whether one is present (`set`) — and the env var names are
 * what to set in the Vercel project, never settable from the app.
 */
import { loadFincruxApiKeys, loadStoredProviderKeyValue } from './provider-api-keys.js';
import { MAX_SEARCHES_PER_DAY as SEARCHES_PER_DAY } from './agent-search.js';

const IST_DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
const FREE_MODEL_PACING_MS = 13000;   // reserveFreeModelSlot in stock-advisor-debate.js
const num = v => Number(v || 0);

// Whether a provider is usable at all. Only the PRESENCE of a key is ever read, never its value, and the names below
// are the environment variables to set in the Vercel project — they cannot be set from the app.
const set = name => String(process.env[name] || '').trim().length > 0;
export async function health(key, configured = false, db = null) {
  // A key saved from the Provider Health card (owner's request 2026-11-24) counts the same as the env var: the real
  // call sites (callFreeModel, callGroqFreeModel, searchWeb) check the same stored value themselves. Only queried for
  // the providers that have anywhere to save one.
  const stored = db && ['free-model', 'web-search', 'groq', 'gemini-vision'].includes(key) ? Boolean(await loadStoredProviderKeyValue(db, key)) : false;
  if (key === 'fincrux') return configured
    ? { status: 'configured', detail: 'Fincrux account keys are configured.', key_env: null }
    : { status: 'needs_key', detail: 'No enabled Fincrux account keys are configured.', key_env: null };
  if (key === 'free-model') {
    if (stored) return { status: 'configured', detail: 'Key saved from this card.', key_env: 'AI_GATEWAY_API_KEY' };
    if (set('AI_GATEWAY_API_KEY')) return { status: 'configured', detail: 'Vercel AI Gateway key present.', key_env: 'AI_GATEWAY_API_KEY' };
    if (set('VERCEL_OIDC_TOKEN')) return { status: 'configured', detail: 'No gateway key; falling back to the deployment OIDC token.', key_env: 'AI_GATEWAY_API_KEY' };
    return { status: 'needs_key', detail: 'No gateway key and no OIDC token, so no model call can be made.', key_env: 'AI_GATEWAY_API_KEY' };
  }
  if (key === 'web-search') {
    if (stored) return { status: 'configured', detail: 'Key saved from this card.', key_env: 'TAVILY_API_KEY' };
    return set('TAVILY_API_KEY')
      ? { status: 'configured', detail: 'Free web search is enabled for the debate agents.', key_env: 'TAVILY_API_KEY' }
      : { status: 'needs_key', detail: 'No search key, so the agents are not offered web search at all.', key_env: 'TAVILY_API_KEY' };
  }
  if (key === 'groq') {
    if (!stored && !set('GROQ_API_KEY')) return { status: 'needs_key', detail: 'Optional fallback model; no key set.', key_env: 'GROQ_API_KEY' };
    return String(process.env.GROQ_ZERO_DATA_RETENTION_CONFIRMED || '').toLowerCase() === 'true'
      ? { status: 'configured', detail: (stored ? 'Key saved from this card' : 'Key set') + ' and zero-data-retention confirmed.', key_env: 'GROQ_API_KEY' }
      : { status: 'blocked', detail: 'A key is set but GROQ_ZERO_DATA_RETENTION_CONFIRMED is not true, so it stays unused.', key_env: 'GROQ_ZERO_DATA_RETENTION_CONFIRMED' };
  }
  if (key === 'gemini-vision') {
    if (stored) return { status: 'configured', detail: 'Key saved from this card. Free tier reads screenshots and PDF statements.', key_env: 'GEMINI_API_KEY' };
    return set('GEMINI_API_KEY')
      ? { status: 'configured', detail: 'Free tier reads screenshots and PDF statements.', key_env: 'GEMINI_API_KEY' }
      : { status: 'needs_key', detail: 'No key set, so screenshot/PDF uploads fall back to the paid Gateway path if one is configured, or are refused.', key_env: 'GEMINI_API_KEY' };
  }
  return { status: 'available', detail: 'Open data; no key needed.', key_env: null };
}

/**
 * The full provider directory for today (IST), read live from wealth_api_audit, wealth_stock_advisor_research_sources,
 * wealth_stock_advisor_messages and the stored Fincrux accounts. Returns { providers, fincruxQuotas,
 * activeFincruxAccounts } — `providers` is the list both pages render.
 */
// Every provider key this directory knows about, so a save request can be checked against a fixed list rather than
// writing whatever string a request body sends (owner's request 2026-11-24: "every card need edit option").
export const PROVIDER_KEYS = Object.freeze(['fincrux', 'free-model', 'tejhq', 'mfapi', 'nse', 'yahoo', 'fx', 'groq', 'agent-web', 'web-search', 'period-match', 'gemini-vision']);

export async function buildProviderDirectory(sql) {
  const activeFincruxAccounts = await loadFincruxApiKeys(sql);
  const fincruxLimit = 5 * activeFincruxAccounts.length;

  // One row per provider call made by today's data collection runs.
  const steps = await sql.query(`SELECT s->>'provider' AS provider,
      count(*)::int AS calls,
      count(*) FILTER (WHERE s->>'status' IN ('failed','unavailable','market_data_failed'))::int AS failed,
      count(*) FILTER (WHERE s->>'status' = 'skipped')::int AS skipped,
      sum(CASE WHEN s->>'ms' ~ '^[0-9]+$' THEN (s->>'ms')::int ELSE 0 END)::int AS total_ms,
      max(r.started_at) AS last_at
    FROM wealth_stock_advisor_data_collection_runs r,
      LATERAL jsonb_array_elements(COALESCE(r.summary->'steps','[]'::jsonb)) s
    WHERE r.started_at >= ${IST_DAY}
    GROUP BY 1`);
  const byProvider = new Map(steps.map(s => [String(s.provider || ''), s]));

  const [fincrux] = await sql.query(`SELECT count(*)::int AS used, max(retrieved_at) AS last_at
    FROM wealth_stock_advisor_research_sources
    WHERE publisher='Fincrux' AND retrieved_at >= ${IST_DAY}
      AND retrieved_at < (${IST_DAY} + interval '1 day')`);
  // The reservation url ends in '#key-<encodeURIComponent(id)>', and a manual call appends '-manual-<uuid>' to that
  // (stock-advisor-fincrux.js). The suffix is stripped here: without it a manual call spends one of the five and this
  // per-account panel still showed the account as untouched, while the provider total above counted it.
  const fincruxAccountRows = await sql.query(`SELECT regexp_replace(regexp_replace(url, '^.*#key-', ''), '-manual-.*$', '') AS key_id,
      count(*)::int AS used
    FROM wealth_stock_advisor_research_sources
    WHERE publisher='Fincrux' AND retrieved_at >= ${IST_DAY}
      AND retrieved_at < (${IST_DAY} + interval '1 day') AND url LIKE '%#key-%'
    GROUP BY 1`);
  const fincruxUsageByKey = new Map(fincruxAccountRows.map(row => [String(row.key_id), num(row.used)]));
  const fincruxQuotas = activeFincruxAccounts.map(key => {
    // One lookup for both numbers: they disagreed when the id needed encoding.
    const used = fincruxUsageByKey.get(encodeURIComponent(key.id)) || 0;
    return { label: key.label, source: key.source, limit: 5, used, remaining: Math.max(0, 5 - used) };
  });

  // Every debate message is one free-model call, except the evidence-gate result, which uses none.
  const [model] = await sql.query(`SELECT
      count(*) FILTER (WHERE COALESCE(metadata->>'no_model','') <> 'true')::int AS calls,
      count(*) FILTER (WHERE metadata->>'no_model' = 'true')::int AS without_model,
      sum(CASE WHEN metadata->'usage'->>'prompt_tokens' ~ '^[0-9]+$' THEN (metadata->'usage'->>'prompt_tokens')::int ELSE 0 END)::int AS prompt_tokens,
      sum(CASE WHEN metadata->'usage'->>'completion_tokens' ~ '^[0-9]+$' THEN (metadata->'usage'->>'completion_tokens')::int ELSE 0 END)::int AS completion_tokens,
      max(created_at) AS last_at
    FROM wealth_stock_advisor_messages WHERE created_at >= ${IST_DAY}`);

  const [slot] = await sql.query(`SELECT next_allowed_at FROM wealth_stock_advisor_ai_rate_limit WHERE id=1`).catch(() => []);
  const waitMs = slot?.next_allowed_at ? Math.max(0, new Date(slot.next_allowed_at).getTime() - Date.now()) : 0;

  // One row per request actually sent today (IST), split by whether the provider answered or errored. A skipped or
  // deferred step is not a request: it sent nothing and used no allowance, so it is reported separately and never
  // counted as usage.
  const answered = await sql.query(`SELECT provider,
      count(*) FILTER (WHERE ok)::int AS succeeded,
      count(*) FILTER (WHERE NOT ok)::int AS failed,
      count(*)::int AS requests,
      sum(COALESCE(duration_ms,0))::int AS total_ms,
      max(created_at) AS last_at
    FROM wealth_api_audit WHERE created_at >= ${IST_DAY} GROUP BY 1`).catch(() => []);
  const answeredByProvider = new Map(answered.map(a => [String(a.provider || ''), a]));

  const fromSteps = (label, extra = {}) => {
    const s = byProvider.get(label) || {};
    const a = answeredByProvider.get(label) || {};
    return {
      // what the provider answered, success or error: this is the usage
      requests: num(a.requests), succeeded: num(a.succeeded), failed: num(a.failed),
      calls: num(a.requests),
      total_ms: num(a.total_ms) || num(s.total_ms),
      last_at: a.last_at || s.last_at || null,
      // planned work that never reached the provider, shown apart from usage
      skipped: num(s.skipped),
      ...extra,
    };
  };

  // health() is async (it may check a stored key), so every result is resolved before the array literal is built -
  // a spread cannot await a Promise.
  const [hFincrux, hFreeModel, hTejhq, hMfapi, hNse, hYahoo, hFx, hGroq, hAgentWeb, hWebSearch, hPeriodMatch, hGeminiVision] = await Promise.all([
    health('fincrux', fincruxLimit > 0, sql), health('free-model', false, sql), health('tejhq', false, sql), health('mfapi', false, sql),
    health('nse', false, sql), health('yahoo', false, sql), health('fx', false, sql), health('groq', false, sql),
    health('agent-web', false, sql), health('web-search', false, sql), health('period-match', false, sql), health('gemini-vision', false, sql),
  ]);

  const providers = [
    {
      key: 'fincrux', name: 'Fincrux', purpose: 'Company financial statements',
      limit: fincruxLimit, limit_window: 'per day (IST; 5 per account)', used: num(fincrux?.used), remaining: Math.max(0, fincruxLimit - num(fincrux?.used)),
      account_count: activeFincruxAccounts.length, account_quotas: fincruxQuotas,
      resets_at_ist: 'midnight IST', last_at: fincrux?.last_at || null,
      ...fromSteps('Fincrux', {}), ...hFincrux,
      note: 'Five requests per active Fincrux Hobby account each IST day. Each account is reserved and counted separately; failed attempts also consume that account’s allowance.',
    },
    {
      key: 'free-model', name: 'Vercel AI Gateway · Nemotron Free', purpose: 'Bull, Bear and CIO debate steps',
      limit: null, limit_window: 'no daily cap published', pacing_ms: FREE_MODEL_PACING_MS,
      used: num(model?.calls), calls: num(model?.calls), failed: 0, skipped: 0,
      without_model: num(model?.without_model), prompt_tokens: num(model?.prompt_tokens), completion_tokens: num(model?.completion_tokens),
      next_slot_in_ms: waitMs, last_at: model?.last_at || null, ...hFreeModel,
      note: 'Paced to one call every 13 seconds (five a minute) across all runs. Calls answered without the model, such as the evidence-gate result, are counted separately.',
    },
    { key: 'tejhq', name: 'TejHQ', purpose: 'NSE end-of-day prices and indicators', limit: null, limit_window: 'no published limit', ...fromSteps('TejHQ NSE EOD'), used: num((answeredByProvider.get('TejHQ NSE EOD') || {}).requests), ...hTejhq,
      note: 'One request per holding per run. No quota is published, so none is enforced here.' },
    { key: 'mfapi', name: 'MFAPI.in', purpose: 'Mutual fund NAV', limit: null, limit_window: 'no published limit', ...fromSteps('MFAPI.in'), used: num((answeredByProvider.get('MFAPI.in') || {}).requests), ...hMfapi,
      note: 'One request per fund per run.' },
    { key: 'nse', name: 'NSE', purpose: 'Announcements, results and the company lists', limit: null, limit_window: 'no published limit', ...fromSteps('NSE RSS'), used: num((answeredByProvider.get('NSE RSS') || {}).requests), ...hNse,
      note: 'Six announcement feeds per run, plus the symbol lists, which are downloaded once and reused for six hours.' },
    { key: 'yahoo', name: 'Yahoo Finance fundamentals', purpose: 'Secondary quarterly figures (never verified)', limit: null,
      limit_window: 'no published limit', ...fromSteps('Yahoo Finance fundamentals'),
      used: num((answeredByProvider.get('Yahoo Finance fundamentals') || {}).requests), ...hYahoo,
      note: 'One request per holding. The figures are stored unverified and never open the evidence gate.' },
    { key: 'fx', name: 'Open currency API', purpose: 'USD to INR reference rate', limit: null,
      limit_window: 'no published limit', ...fromSteps('Open currency API'),
      used: num((answeredByProvider.get('Open currency API') || {}).requests), ...hFx,
      note: 'One published rate a day, cached. Yahoo INR=X is the fallback if it cannot be read.' },
    { key: 'groq', name: 'Groq Free', purpose: 'Optional fallback model', limit: null, limit_window: 'no published limit', used: 0, calls: 0, ...hGroq,
      note: 'Used only if the Vercel gateway fails and zero-data-retention has been confirmed.' },
    // What the debate agents collected for themselves, rather than what the nightly job gathered (2026-11-24).
    { key: 'agent-web', name: 'Agent web', purpose: 'Official pages the agents opened during a debate', limit: null, limit_window: 'allowlisted hosts only',
      ...fromSteps('Agent web'), used: num((answeredByProvider.get('Agent web') || {}).requests), ...hAgentWeb,
      note: 'NSE, BSE, SEBI, AMFI, RBI and Yahoo only. Always unverified context; it never satisfies missing evidence.' },
    { key: 'web-search', name: 'Web search', purpose: 'Free web search the agents may call for context',
      limit: SEARCHES_PER_DAY, limit_window: 'per day (IST), from a free monthly allowance',
      ...fromSteps('Web search'), used: num((answeredByProvider.get('Web search') || {}).requests),
      remaining: Math.max(0, SEARCHES_PER_DAY - num((answeredByProvider.get('Web search') || {}).requests)),
      ...hWebSearch,
      note: 'Results are unverified context and can never unlock a BUY, HOLD or SELL.' },
    { key: 'period-match', name: 'Period match with NSE', purpose: 'Verifying a statement against a filing', limit: null, limit_window: 'database only', ...fromSteps('Period match with NSE'), used: 0, ...hPeriodMatch,
      note: 'Reads what is already stored. It calls no outside service.' },
    // Reads an uploaded payment screenshot or PDF bank/card statement for the user (2026-11-24, "i need free"). Tried
    // before the paid Gateway/Haiku path, and the only one of the two that reads a PDF at all.
    { key: 'gemini-vision', name: 'Gemini Vision', purpose: 'Reading uploaded payment screenshots and PDF statements', limit: null, limit_window: 'free tier; no published daily cap',
      ...fromSteps('Gemini Vision'), used: num((answeredByProvider.get('Gemini Vision') || {}).requests), ...hGeminiVision,
      note: 'Free tier covers image input. PDF input was not separately confirmed free on Google\'s pricing page, so check what each call actually billed.' },
    { key: 'screenshot-gateway', name: 'Vercel AI Gateway · Claude Haiku (screenshots)', purpose: 'Paid fallback for reading payment screenshots', limit: null, limit_window: 'no published limit, billed per use',
      ...fromSteps('Vercel AI Gateway (screenshots)'), used: num((answeredByProvider.get('Vercel AI Gateway (screenshots)') || {}).requests),
      status: set('AI_GATEWAY_API_KEY') ? 'available' : 'needs_key', key_env: 'AI_GATEWAY_API_KEY',
      detail: set('AI_GATEWAY_API_KEY') ? 'Uses the same AI_GATEWAY_API_KEY as the free debate model; billed separately per call.' : 'No gateway key set.',
      note: 'Only reached when Gemini is not configured, or fails on an image upload. Never used for a PDF.' },
  ];

  return { providers, fincruxQuotas, activeFincruxAccounts, fincruxLimit };
}
