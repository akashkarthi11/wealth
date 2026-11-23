// USD→INR reference rate. The primary source is the open currency API (no key, CDN-hosted, 340 currencies, one
// published rate per day); Yahoo's INR=X is kept only as a fallback because it is an undocumented endpoint that has
// broken before. A daily published rate is the right basis for valuing holdings; it is not a live quote.
import { recordApiCall } from './api-audit.js';

const SOURCE = 'Open currency API';
// The project's documented host, and its own published fallback.
const ENDPOINTS = Object.freeze([
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
]);

// The rate, or null when no endpoint answered with a usable number. Never throws.
export async function usdInrRate({ db = null, now = Date.now() } = {}) {
  for (const endpoint of ENDPOINTS) {
    const startedAt = Date.now();
    let payload = null;
    try {
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      payload = await response.json();
      const price = Number(payload?.usd?.inr);
      if (!Number.isFinite(price) || price <= 0) throw new Error('no usd.inr in the response');
      // The published date is a day, so the rate is as of the end of that day.
      const day = String(payload?.date || '').slice(0, 10);
      const asOf = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + 'T23:59:59Z') : new Date(now);
      if (db) await recordApiCall(db, { provider: SOURCE, endpoint, ticker: 'USDINR', httpStatus: response.status, ok: true,
        usable: true, durationMs: Date.now() - startedAt, payload: { date: payload.date, usd_rates: Object.keys(payload.usd || {}).length, usd_inr: price },
        bytes: JSON.stringify(payload).length });
      return { price, asOf, currency: 'INR', source: SOURCE, published_for: day || null };
    } catch (error) {
      if (db) await recordApiCall(db, { provider: SOURCE, endpoint, ticker: 'USDINR', ok: false, usable: false,
        durationMs: Date.now() - startedAt, payload, error: String(error?.message || error).slice(0, 200) });
      console.warn('[fx-rate]', endpoint.split('/')[2], error?.message || error);
    }
  }
  return null;
}
