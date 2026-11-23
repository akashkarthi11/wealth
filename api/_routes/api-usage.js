import { sql, json, sessionUser } from '../_lib.js';

// GET /api/api-usage   (admin only, read only)
// What each outside provider allows, what has been used today, and what is left. Limits are only shown where the
// provider actually publishes one and the code enforces it; everything else says so rather than inventing a number.
const IST_DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
const FREE_MODEL_PACING_MS = 13000;   // reserveFreeModelSlot in stock-advisor-debate.js

async function adminUser(req) {
  const uid = await sessionUser(req);
  if (!uid) return null;
  const [user] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
  return user?.role === 'admin' ? uid : null;
}
const num = v => Number(v || 0);
// Whether a provider is usable at all. Only the PRESENCE of a key is ever read, never its value, and the names below
// are the environment variables to set in the Vercel project — they cannot be set from the app.
const set = name => String(process.env[name] || '').trim().length > 0;
function health(key) {
  if (key === 'fincrux') return set('FINCRUX_API_KEY')
    ? { status: 'configured', detail: 'Key present in this environment.' , key_env: 'FINCRUX_API_KEY' }
    : { status: 'needs_key', detail: 'No key in this environment, so no request is attempted.', key_env: 'FINCRUX_API_KEY' };
  if (key === 'free-model') {
    if (set('AI_GATEWAY_API_KEY')) return { status: 'configured', detail: 'Vercel AI Gateway key present.', key_env: 'AI_GATEWAY_API_KEY' };
    if (set('VERCEL_OIDC_TOKEN')) return { status: 'configured', detail: 'No gateway key; falling back to the deployment OIDC token.', key_env: 'AI_GATEWAY_API_KEY' };
    return { status: 'needs_key', detail: 'No gateway key and no OIDC token, so no model call can be made.', key_env: 'AI_GATEWAY_API_KEY' };
  }
  if (key === 'groq') {
    if (!set('GROQ_API_KEY')) return { status: 'needs_key', detail: 'Optional fallback model; no key set.', key_env: 'GROQ_API_KEY' };
    return String(process.env.GROQ_ZERO_DATA_RETENTION_CONFIRMED || '').toLowerCase() === 'true'
      ? { status: 'configured', detail: 'Key set and zero-data-retention confirmed.', key_env: 'GROQ_API_KEY' }
      : { status: 'blocked', detail: 'Key is set but GROQ_ZERO_DATA_RETENTION_CONFIRMED is not true, so it stays unused.', key_env: 'GROQ_ZERO_DATA_RETENTION_CONFIRMED' };
  }
  return { status: 'available', detail: 'Open data; no key needed.', key_env: null };
}

export default async function handler(req, res) {
  try {
    if (!sql) return json(res, 503, { error: 'Database is not configured' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (!(await adminUser(req))) return json(res, 403, { error: 'Admin sign-in required' });

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

    const fromSteps = (label, extra = {}) => {
      const s = byProvider.get(label) || {};
      return { calls: num(s.calls), failed: num(s.failed), skipped: num(s.skipped), total_ms: num(s.total_ms), last_at: s.last_at || null, ...extra };
    };

    const providers = [
      {
        key: 'fincrux', name: 'Fincrux', purpose: 'Company financial statements',
        limit: 5, limit_window: 'per day (IST)', used: num(fincrux?.used), remaining: Math.max(0, 5 - num(fincrux?.used)),
        resets_at_ist: 'midnight IST', last_at: fincrux?.last_at || null,
        ...fromSteps('Fincrux', {}), ...health('fincrux'),
        note: 'A free-tier key. Each request is reserved in the database before it is sent, so the limit holds even with several runs at once.',
      },
      {
        key: 'free-model', name: 'Vercel AI Gateway · Nemotron Free', purpose: 'Bull, Bear and CIO debate steps',
        limit: null, limit_window: 'no daily cap published', pacing_ms: FREE_MODEL_PACING_MS,
        used: num(model?.calls), calls: num(model?.calls), failed: 0, skipped: 0,
        without_model: num(model?.without_model), prompt_tokens: num(model?.prompt_tokens), completion_tokens: num(model?.completion_tokens),
        next_slot_in_ms: waitMs, last_at: model?.last_at || null, ...health('free-model'),
        note: 'Paced to one call every 13 seconds (five a minute) across all runs. Calls answered without the model, such as the evidence-gate result, are counted separately.',
      },
      { key: 'tejhq', name: 'TejHQ', purpose: 'NSE end-of-day prices and indicators', limit: null, limit_window: 'no published limit', ...fromSteps('TejHQ'), used: num((byProvider.get('TejHQ') || {}).calls), ...health('tejhq'),
        note: 'One request per holding per run. No quota is published, so none is enforced here.' },
      { key: 'mfapi', name: 'MFAPI.in', purpose: 'Mutual fund NAV', limit: null, limit_window: 'no published limit', ...fromSteps('MFAPI.in'), used: num((byProvider.get('MFAPI.in') || {}).calls), ...health('mfapi'),
        note: 'One request per fund per run.' },
      { key: 'nse', name: 'NSE', purpose: 'Announcements, results and the company lists', limit: null, limit_window: 'no published limit', ...fromSteps('NSE RSS'), used: num((byProvider.get('NSE RSS') || {}).calls), ...health('nse'),
        note: 'Six announcement feeds per run, plus the symbol lists, which are downloaded once and reused for six hours.' },
      { key: 'groq', name: 'Groq Free', purpose: 'Optional fallback model', limit: null, limit_window: 'no published limit', used: 0, calls: 0, ...health('groq'),
        note: 'Used only if the Vercel gateway fails and zero-data-retention has been confirmed.' },
      { key: 'period-match', name: 'Period match with NSE', purpose: 'Verifying a statement against a filing', limit: null, limit_window: 'database only', ...fromSteps('Period match with NSE'), used: num((byProvider.get('Period match with NSE') || {}).calls), ...health('period-match'),
        note: 'Reads what is already stored. It calls no outside service.' },
    ];

    // The latest audited response per provider: what the outside service actually returned, shape and all.
    const audit = await sql.query(`SELECT DISTINCT ON (provider) provider, ticker, endpoint, http_status, ok, usable,
        duration_ms, bytes, response_keys, data_keys, section_counts, sample, error, created_at
      FROM wealth_api_audit ORDER BY provider, created_at DESC`).catch(() => []);
    const auditByProvider = new Map(audit.map(a => [a.provider, a]));
    for (const p of providers) {
      const a = auditByProvider.get(p.name) || auditByProvider.get(p.key);
      if (a) p.audit = a;
    }
    return json(res, 200, { day: 'today, IST', providers, audit, generated_at: new Date().toISOString(),
      config_note: 'Keys are environment variables in the Vercel project. They are never shown here and cannot be changed from the app.' });
  } catch (error) {
    console.error('[api-usage]', error?.message || error);
    return json(res, 500, { error: 'Could not load API usage.' });
  }
}
