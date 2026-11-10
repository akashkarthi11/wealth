import { sql, schema, json, sessionUser, cacheGet, cacheSet } from '../_lib.js';

const EXA_URL = 'https://api.exa.ai/search';
const MASSIVE_BASE = 'https://api.massive.com';
const MAX_QUERY = 400;

async function providerJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(9000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || data?.message || 'Provider request failed';
    throw new Error(String(message).slice(0, 240));
  }
  return data;
}

async function owner(req) {
  const uid = await sessionUser(req);
  if (!uid) return { error: [401, 'Sign in required'] };
  await schema();
  const rows = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
  if (!rows.length) return { error: [401, 'Sign in required'] };
  if (rows[0].role !== 'admin') return { error: [403, 'Owner admin only'] };
  return { uid };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const auth = await owner(req);
    if (auth.error) return json(res, auth.error[0], { error: auth.error[1] });

    let input = {};
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (raw.length > 12000) return json(res, 413, { error: 'Request too large' });
      input = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }

    const action = String(input.action || '');
    if (action === 'status') {
      return json(res, 200, {
        exa: { configured: Boolean(process.env.EXA_API_KEY), purpose: 'Financial research and source discovery' },
        massive: { configured: Boolean(process.env.MASSIVE_API_KEY), purpose: 'Structured market data; endpoint availability depends on supported market and ticker' }
      });
    }

    if (action === 'research') {
      const query = String(input.query || '').trim().slice(0, MAX_QUERY);
      if (query.length < 3) return json(res, 400, { error: 'Enter a research query (at least 3 characters).' });
      const key = process.env.EXA_API_KEY;
      if (!key) return json(res, 200, { connected: false, setupRequired: true, provider: 'Exa', missing: ['EXA_API_KEY'] });
      const cacheKey = 'wealth:exa:v1:' + Buffer.from(query.toLowerCase()).toString('base64url').slice(0, 160);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        try { return json(res, 200, { ...JSON.parse(cached), cached: true }); } catch {}
      }
      const result = await providerJson(EXA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: 8,
          contents: { text: { maxCharacters: 1800 } }
        })
      });
      const payload = {
        connected: true,
        provider: 'Exa',
        fetchedAt: new Date().toISOString(),
        results: (result.results || []).slice(0, 8).map(item => ({
          title: item.title || '',
          url: item.url || '',
          publishedDate: item.publishedDate || null,
          text: String(item.text || '').slice(0, 1800)
        }))
      };
      await cacheSet(cacheKey, payload, 900);
      return json(res, 200, payload);
    }

    if (action === 'quote') {
      const ticker = String(input.ticker || '').trim().toUpperCase();
      // Massive's Stocks aggregates are queried only for explicitly requested symbols.
      // This adapter currently uses the US Stocks previous-session endpoint; it does not
      // pretend that an unsupported Indian ticker has a valid quote.
      if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker)) return json(res, 400, { error: 'Invalid ticker symbol.' });
      const key = process.env.MASSIVE_API_KEY;
      if (!key) return json(res, 200, { connected: false, setupRequired: true, provider: 'Massive', missing: ['MASSIVE_API_KEY'] });
      const cacheKey = 'wealth:massive:us-prev:v1:' + ticker;
      const cached = await cacheGet(cacheKey);
      if (cached) {
        try { return json(res, 200, { ...JSON.parse(cached), cached: true }); } catch {}
      }
      const url = MASSIVE_BASE + '/v2/aggs/ticker/' + encodeURIComponent(ticker) + '/prev?adjusted=true&apiKey=' + encodeURIComponent(key);
      const result = await providerJson(url);
      if (result.status && !['OK', 'DELAYED'].includes(String(result.status).toUpperCase())) {
        return json(res, 422, { connected: true, provider: 'Massive', ticker, error: 'No supported quote returned for this ticker.', providerStatus: result.status });
      }
      const row = result.results?.[0];
      if (!row) return json(res, 404, { connected: true, provider: 'Massive', ticker, error: 'No previous-session quote found. Check ticker and market support.' });
      const payload = {
        connected: true,
        provider: 'Massive',
        market: 'US stocks',
        ticker,
        currency: 'USD',
        session: 'previous trading session',
        fetchedAt: new Date().toISOString(),
        timestamp: row.t ? new Date(row.t).toISOString() : null,
        open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v,
        adjusted: true
      };
      await cacheSet(cacheKey, payload, 300);
      return json(res, 200, payload);
    }

    return json(res, 400, { error: 'Unsupported action. Use status, research, or quote.' });
  } catch (error) {
    console.error('[wealth-providers]', error?.message || error);
    return json(res, 502, { error: 'Provider request failed. Check server configuration and provider access.' });
  }
}
