// What an outside provider actually returned. Recording the SHAPE of a response means a free-tier request is never
// spent twice just to find out what came back (Fincrux gives five a day, and five were spent on 23 Nov learning nothing).
// Never stores a secret and never a whole payload.

const SECRET_PARAMS = /^(api_?key|key|token|secret|password|access_token|auth)$/i;
const MAX_KEYS = 40;
const MAX_SAMPLE_CHARS = 400;

// The endpoint with any secret query value replaced, so it is safe to store and to show.
export function safeEndpoint(url) {
  const text = String(url || '');
  try {
    const parsed = new URL(text);
    for (const name of [...parsed.searchParams.keys()]) if (SECRET_PARAMS.test(name)) parsed.searchParams.set(name, 'REDACTED');
    return parsed.toString().slice(0, 500);
  } catch {
    return text.replace(/([?&](?:api_?key|key|token|secret|access_token|auth)=)[^&]*/gi, '$1REDACTED').slice(0, 500);
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// One line per field: how many rows an array holds, how many keys an object holds, or the kind of value it is.
// This is the answer to "what data did we actually get".
export function describeShape(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (Array.isArray(item)) out[key] = item.length;
    else if (isPlainObject(item)) out[key] = Object.keys(item).length ? 'object(' + Object.keys(item).length + ')' : 'empty object';
    else if (item === null || item === undefined || item === '') out[key] = 'empty';
    else out[key] = typeof item === 'string' ? 'text(' + item.length + ')' : typeof item;
  }
  return out;
}

// A short, readable excerpt: the first row of each array and any short scalar, trimmed hard.
export function sampleOf(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (Array.isArray(item) && item.length) out[key] = JSON.parse(JSON.stringify(item[0])) ;
    else if (typeof item === 'string' && item.length <= 120) out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = item;
  }
  const text = JSON.stringify(out);
  return text.length <= MAX_SAMPLE_CHARS ? out : { note: 'sample too large', fields: Object.keys(out).slice(0, 12) };
}

// Record one call. Never throws: an audit failure must not break a collection run.
export async function recordApiCall(db, { provider, endpoint, ticker = null, httpStatus = null, ok = false, durationMs = null,
  payload = null, bytes = null, usable = null, error = null } = {}) {
  try {
    const top = isPlainObject(payload) ? payload : null;
    const data = isPlainObject(top?.data) ? top.data : null;
    await db.query(`WITH actor AS MATERIALIZED (SELECT set_config('wealth.actor', 'agent', true))
      INSERT INTO wealth_api_audit
      (provider,endpoint,ticker,http_status,ok,duration_ms,bytes,response_keys,data_keys,section_counts,sample,usable,error)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10::jsonb,$11::jsonb,$12,$13 FROM actor`,
      [String(provider || 'unknown').slice(0, 80), safeEndpoint(endpoint), ticker ? String(ticker).toUpperCase().slice(0, 40) : null,
        httpStatus, !!ok, durationMs, bytes,
        top ? Object.keys(top).slice(0, MAX_KEYS) : [],
        data ? Object.keys(data).slice(0, MAX_KEYS) : [],
        JSON.stringify(describeShape(data || top)),
        JSON.stringify(sampleOf(data || top)),
        usable === null ? null : !!usable,
        error ? String(error).slice(0, 400) : null]);
  } catch (auditError) {
    console.warn('[api-audit]', auditError?.message || auditError);
  }
}
