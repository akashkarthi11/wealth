import { sql, schema, json, sessionUser, cacheGet, cacheSet } from '../_lib.js';
import { addFincruxApiKey, listFincruxKeyMetadata } from '../_lib/provider-api-keys.js';

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
    if (action === 'fincrux_keys') {
      return json(res, 200, { provider: 'Fincrux', ...(await listFincruxKeyMetadata(sql, auth.uid)) });
    }
    if (action === 'fincrux_key_add') {
      const saved = await addFincruxApiKey(sql, auth.uid, { key: input.key, label: input.label });
      return json(res, 201, { saved: true, key: { id: saved.id, label: saved.label, priority: saved.priority, enabled: saved.enabled },
        ...(await listFincruxKeyMetadata(sql, auth.uid)) });
    }
    if (action === 'fincrux_key_update') {
      const id = String(input.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Invalid key ID.' });
      const enabled = input.enabled === true;
      const updated = await sql.query("UPDATE wealth_provider_api_keys SET enabled=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND provider='fincrux' RETURNING id", [id, auth.uid, enabled]);
      if (!updated.length) return json(res, 404, { error: 'Saved Fincrux key not found.' });
      return json(res, 200, { saved: true, ...(await listFincruxKeyMetadata(sql, auth.uid)) });
    }
    if (action === 'fincrux_key_configure') {
      const id = String(input.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Invalid key ID.' });
      const userAgent = String(input.user_agent || 'WealthPersonalStockResearch/1.0').trim();
      if (!userAgent || userAgent.length > 200 || /[\r\n]/.test(userAgent)) return json(res, 400, { error: 'User-Agent must be 1–200 characters on one line.' });
      const assigned = Array.isArray(input.assigned_tickers) ? [...new Set(input.assigned_tickers.map(x => String(x || '').trim().toUpperCase()).filter(Boolean))] : [];
      if (assigned.length > 100 || assigned.some(x => !/^[A-Z0-9&.-]{1,30}$/.test(x))) return json(res, 400, { error: 'Ticker assignments must contain up to 100 valid ticker symbols.' });
      const updated = await sql.query("UPDATE wealth_provider_api_keys SET user_agent=$3,assigned_tickers=$4::text[],updated_at=now() WHERE id=$1 AND user_id=$2 AND provider='fincrux' RETURNING id", [id, auth.uid, userAgent, assigned]);
      if (!updated.length) return json(res, 404, { error: 'Saved Fincrux key not found.' });
      return json(res, 200, { saved: true, ...(await listFincruxKeyMetadata(sql, auth.uid)) });
    }
    if (action === 'fincrux_key_delete') {
      const id = String(input.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Invalid key ID.' });
      const deleted = await sql.query("DELETE FROM wealth_provider_api_keys WHERE id=$1 AND user_id=$2 AND provider='fincrux' RETURNING id", [id, auth.uid]);
      if (!deleted.length) return json(res, 404, { error: 'Saved Fincrux key not found.' });
      return json(res, 200, { deleted: true, ...(await listFincruxKeyMetadata(sql, auth.uid)) });
    }
    if (action === 'status') {
      const fincrux = await listFincruxKeyMetadata(sql, auth.uid);
      return json(res, 200, {
        exa: { configured: Boolean(process.env.EXA_API_KEY), purpose: 'Financial research and source discovery' },
        fincrux: { configured: fincrux.total_enabled > 0, environmentKeys: fincrux.environment.length, databaseKeys: fincrux.database.length, purpose: 'Ordered financial-statement provider keys with automatic fallback' },
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

    return json(res, 400, { error: 'Unsupported action. Use status, fincrux_keys, fincrux_key_add, fincrux_key_update, fincrux_key_configure, fincrux_key_delete, research, or quote.' });
  } catch (error) {
    if (error?.status) return json(res, error.status, { error: error.message });
    console.error('[wealth-providers]', error?.message || error);
    return json(res, 502, { error: 'Provider request failed. Check server configuration and provider access.' });
  }
}
