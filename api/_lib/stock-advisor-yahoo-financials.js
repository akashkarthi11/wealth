// Quarterly financial figures for an NSE-listed company, from Yahoo's fundamentals timeseries. No key and no quota,
// and the app already reaches Yahoo from Production for prices and FX. Fincrux's free tier returns no statement arrays
// at all (owner's Production run, 23 Nov 2026), so this fills the gap for holdings the filed XBRL has not covered yet.
//
// SECONDARY SOURCE, ALWAYS UNVERIFIED. Only figures parsed from the NSE-filed XBRL instance may be verified
// (api/_lib/stock-advisor-nse-xbrl.js); a third party's copy of the numbers is never promoted, not even when an NSE
// announcement exists for the same period. These rows give the analysts real figures to reason about; they do not
// open the evidence gate, and nothing here may change that.
import { recordApiCall } from './api-audit.js';

const SOURCE = 'Yahoo Finance fundamentals';
const BASE = 'https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/';
// Only figures an analyst actually argues from. Yahoo names them in camelCase with a "quarterly" prefix.
const TYPES = Object.freeze([
  'quarterlyTotalRevenue', 'quarterlyPretaxIncome', 'quarterlyNetIncome', 'quarterlyBasicEPS',
  'quarterlyTotalAssets', 'quarterlyTotalLiabilitiesNetMinorityInterest', 'quarterlyOperatingCashFlow',
]);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const monthOf = day => (/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day).slice(0, 7) : null);

// Yahoo returns one result block per requested type, each holding rows of {asOfDate, periodType, reportedValue}.
export function parseYahooFinancials(payload) {
  const blocks = Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result : [];
  const byPeriod = new Map();
  for (const block of blocks) {
    const type = String(block?.meta?.type?.[0] || '');
    const rows = Array.isArray(block?.[type]) ? block[type] : [];
    for (const row of rows) {
      if (!row) continue;
      const period = monthOf(row.asOfDate);
      const value = num(row.reportedValue?.raw ?? row.reportedValue);
      if (!period || value === null) continue;
      if (!byPeriod.has(period)) byPeriod.set(period, { period, as_of: row.asOfDate, period_type: row.periodType || null, currency: row.currencyCode || null, figures: {} });
      byPeriod.get(period).figures[type.replace(/^quarterly/, '')] = value;
    }
  }
  // Newest quarter first; a quarter with no figures at all is not a quarter.
  return [...byPeriod.values()].filter(q => Object.keys(q.figures).length).sort((a, b) => b.period.localeCompare(a.period));
}

// Fetch and store the newest quarters for one NSE ticker. Never throws; returns what happened.
export async function collectYahooFinancials({ instrument, db, now = Date.now() } = {}) {
  const symbol = String(instrument?.symbol || '').trim().toUpperCase();
  const result = { provider: SOURCE, ticker: symbol, status: 'skipped', quarters: 0 };
  if (!/^[A-Z0-9&.-]{1,30}$/.test(symbol)) { result.status = 'failed'; result.error = 'Invalid NSE ticker.'; return result; }

  const yahooSymbol = symbol + '.NS';
  const period2 = Math.floor(now / 1000), period1 = period2 - 4 * 365 * 86400;
  const endpoint = BASE + encodeURIComponent(yahooSymbol) + '?symbol=' + encodeURIComponent(yahooSymbol)
    + '&type=' + TYPES.join(',') + '&period1=' + period1 + '&period2=' + period2;
  const startedAt = Date.now();
  let payload = null;
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Yahoo fundamentals HTTP ' + response.status);
    payload = await response.json();
    const quarters = parseYahooFinancials(payload);
    await recordApiCall(db, { provider: SOURCE, endpoint, ticker: symbol, httpStatus: response.status, ok: true,
      usable: quarters.length > 0, durationMs: Date.now() - startedAt, bytes: JSON.stringify(payload).length,
      payload: { data: { quarters: quarters.map(q => q.period), figures: quarters[0]?.figures || {} } } });
    if (!quarters.length) {
      result.status = 'failed';
      result.error = 'Yahoo returned no quarterly figures. Blocks: ' + (Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result.length : 0)
        + (payload?.timeseries?.error ? '; error ' + JSON.stringify(payload.timeseries.error).slice(0, 120) : '');
      return result;
    }

    const latest = quarters[0];
    const url = 'https://finance.yahoo.com/quote/' + encodeURIComponent(yahooSymbol) + '/financials';
    const evidence = {
      provider: SOURCE, source_kind: 'third_party_aggregator', ticker: symbol, yahoo_symbol: yahooSymbol,
      endpoint: BASE + yahooSymbol, latest_period: latest.period, latest_as_of: latest.as_of, currency: latest.currency,
      requested_types: TYPES, quarters: quarters.slice(0, 8),
      verification_note: 'Figures as reported by a third-party aggregator, not read from a filed document. They never '
        + 'satisfy the verified financial-statement gate: only the NSE-filed XBRL instance does. Use them as context, '
        + 'and say in any analysis that they are unverified.',
    };
    const excerpt = [symbol, 'quarter ending ' + latest.as_of,
      ...Object.entries(latest.figures).slice(0, 5).map(([k, v]) => k + ' ' + v)].join(' · ').slice(0, 1000);
    await db.query(`INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      VALUES (NULL,$1,'financial_statement',$2,$3,$4,$5::timestamptz,now(),$6,$7::jsonb,'unverified')
      ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE
        SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,
            evidence=EXCLUDED.evidence,verification_status='unverified'`,
      [symbol, 'Quarterly financials — ' + symbol, url, SOURCE, latest.as_of + 'T00:00:00Z', excerpt, JSON.stringify(evidence)]);

    result.status = 'stored_unverified';
    result.quarters = quarters.length;
    result.latest_period = latest.period;
    result.figures = Object.keys(latest.figures).length;
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = String(error?.message || error).slice(0, 240);
    await recordApiCall(db, { provider: SOURCE, endpoint, ticker: symbol, ok: false, usable: false,
      durationMs: Date.now() - startedAt, payload, error: result.error });
    return result;
  }
}
