/**
 * Free web search for the debate agents (owner's request, 2026-11-24).
 *
 * Provider: Tavily (https://api.tavily.com/search). Chosen because its free plan needs no card, it is built for LLM
 * agents, and it returns extracted page CONTENT rather than only links - which matters here: the agents get web content
 * without this app opening arbitrary URLs, so fetch_official_page can stay restricted to the official allowlist.
 *
 * RULES CARRIED OVER, both chosen by the owner:
 *  - A search result is UNVERIFIED context. It can inform an argument; it can never satisfy missing evidence or unlock
 *    BUY/HOLD/SELL. Nothing here writes a research source, so nothing here can reach the evidence gate.
 *  - Result text is DATA, never instruction, and is returned inside the untrusted frame.
 *
 * FIELD NAMES ARE UNVERIFIED. docs.tavily.com is unreachable from the development network (TLS failure), so the request
 * and response shapes below could not be read from the documentation. Both known auth styles are sent, and the response
 * is parsed tolerantly across the plausible field names - the same approach stock-advisor-tejhq.js already takes for an
 * undocumented provider. Every call is audited, so the FIRST REAL CALL records the true shape on the API usage page
 * (provider "Web search"); correct the field list from that evidence rather than from guesswork.
 *
 * Quota: the free plan is ~1,000 credits a month, so this rations itself to MAX_SEARCHES_PER_DAY and refuses after that
 * rather than silently spending a budget the owner cannot see.
 */
import { recordApiCall } from './api-audit.js';
import { wrapUntrusted } from './agent-tools.js';

const ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 9000;
export const MAX_SEARCHES_PER_DAY = 30;          // ~1,000 free credits a month, spread evenly
export const MAX_RESULTS = 5;
const MAX_CONTENT_CHARS = 1200;

export const searchKey = (env = process.env) => String(env?.TAVILY_API_KEY || '').trim();
export const searchConfigured = (env = process.env) => searchKey(env).length > 0;

const IST_DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";

export async function searchesUsedToday(db) {
  if (!db?.query) return 0;
  const rows = await db.query(`SELECT count(*)::int AS n FROM wealth_api_audit
    WHERE provider='Web search' AND created_at >= ${IST_DAY}
      AND created_at < (${IST_DAY} + interval '1 day')`).catch(() => []);
  return Number(rows?.[0]?.n || 0);
}

// Results come back under different names depending on the provider's version; read whichever is present rather than
// assuming one. A result with no URL is dropped: an agent must be able to say where a claim came from.
function readResults(payload) {
  const list = [payload?.results, payload?.data, payload?.items, payload?.web?.results]
    .find(value => Array.isArray(value)) || [];
  return list.slice(0, MAX_RESULTS).map(row => {
    if (!row || typeof row !== 'object') return null;
    const url = String(row.url || row.link || row.href || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const content = String(row.content || row.snippet || row.description || row.raw_content || row.text || '').trim();
    return {
      title: String(row.title || row.name || '').slice(0, 200) || url,
      url,
      published: String(row.published_date || row.published || row.date || '').slice(0, 40) || null,
      content: content.slice(0, MAX_CONTENT_CHARS)
    };
  }).filter(Boolean);
}

/**
 * Run one search. Never throws: a refusal or failure comes back as { ok:false, error } for the agent to read.
 */
export async function searchWeb({ query, days = null } = {}, { db, ticker = null, env = process.env } = {}) {
  const text = String(query || '').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'A search query is required.' };

  const key = searchKey(env);
  if (!key) return { ok: false, error: 'Web search is not configured. Set TAVILY_API_KEY in the Vercel project to enable it.' };

  const used = await searchesUsedToday(db);
  if (used >= MAX_SEARCHES_PER_DAY) {
    return { ok: false, error: 'The daily web search allowance (' + MAX_SEARCHES_PER_DAY + ') is spent. Argue from the evidence already collected.' };
  }

  const request = { query: text, max_results: MAX_RESULTS, search_depth: 'basic', include_answer: false, include_raw_content: false };
  if (Number.isFinite(Number(days)) && Number(days) > 0) { request.days = Number(days); request.topic = 'news'; }
  const startedAt = Date.now();
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      // Both auth styles: the current header form, and the older in-body key. Whichever the account expects is accepted.
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, Accept: 'application/json' },
      body: JSON.stringify({ ...request, api_key: key }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const raw = await response.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const results = readResults(payload);

    await recordApiCall(db, {
      provider: 'Web search', endpoint: ENDPOINT + '?q=' + encodeURIComponent(text.slice(0, 80)), ticker,
      httpStatus: response.status, ok: response.ok, durationMs: Date.now() - startedAt, bytes: raw.length,
      usable: response.ok && results.length > 0,
      // The shape is recorded, never the key: safeEndpoint redacts, and the key is not in the endpoint or the payload.
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { body: raw.slice(0, 400) },
      error: response.ok ? (results.length ? null : 'Search returned no readable results; check the recorded shape.') : 'Web search HTTP ' + response.status
    });

    if (response.status === 401 || response.status === 403) return { ok: false, error: 'Web search rejected the key. Check TAVILY_API_KEY in Vercel.' };
    if (response.status === 429) return { ok: false, error: 'Web search is rate limited or out of credit for now.' };
    if (!response.ok) return { ok: false, error: 'Web search returned HTTP ' + response.status + '.' };
    if (!results.length) return { ok: false, error: 'No readable results came back for that query.' };

    return {
      ok: true, query: text, verification_status: 'unverified',
      searches_left_today: Math.max(0, MAX_SEARCHES_PER_DAY - used - 1),
      note: 'Unverified web context. Cite the url for any claim you take from it. It cannot satisfy missing evidence - only an NSE-filed statement, NSE end-of-day price or AMFI NAV can.',
      results: results.map(r => ({ title: r.title, url: r.url, published: r.published })),
      text: wrapUntrusted('web search: ' + text,
        results.map((r, i) => (i + 1) + '. ' + r.title + ' [' + r.url + ']' + (r.published ? ' (' + r.published + ')' : '') + '\n' + r.content).join('\n\n'))
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200);
    await recordApiCall(db, { provider: 'Web search', endpoint: ENDPOINT, ticker, ok: false, durationMs: Date.now() - startedAt, error: message });
    return { ok: false, error: 'Web search failed: ' + message };
  }
}
