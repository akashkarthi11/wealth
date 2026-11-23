const BASE = 'https://api.fincrux.org/api/financials';
const SOURCE = 'Fincrux';
const MAX_DAILY_REQUESTS = 5;
import { recordApiCall } from './api-audit.js';
import { loadFincruxApiKeys } from './provider-api-keys.js';
const timeout = ms => AbortSignal.timeout(ms);
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safeDate = value => {
  if (!value) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
};
// Fincrux statement tables may contain object rows or positional array rows. Keep both:
 // Dropping nested arrays silently turns valid API responses into "no statements".
const rows = value => Array.isArray(value)
  ? value.filter(x => x !== null && typeof x === 'object').slice(0, 60)
  : [];
const firstPopulatedArray = (...values) =>
  values.find(value => Array.isArray(value) && value.length) || values.find(Array.isArray) || [];

export function normalizeFincruxFinancials(payload, expectedTicker) {
  const symbol = clean(payload?.trading_symbol).toUpperCase();
  const expected = clean(expectedTicker).toUpperCase();
  if (payload?.success !== true && String(payload?.success).toLowerCase() !== 'true') {
    throw new Error('Fincrux did not confirm a successful financials response.');
  }
  if (!symbol || symbol !== expected) {
    throw new Error('Fincrux symbol mismatch; expected ' + expected + ' but received ' + (symbol || 'empty') + '.');
  }
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Fincrux returned no structured financial data. Response keys: ' + Object.keys(payload || {}).slice(0, 12).join(', '));
  }
  const financials = {
    quarterly_results: rows(firstPopulatedArray(data.quarterly_results, data.quaterly_results)).slice(0, 20),
    profit_and_loss: rows(data.profit_and_loss).slice(0, 12),
    balance_sheet: rows(data.balance_sheet).slice(0, 12),
    cash_flows: rows(data.cash_flows).slice(0, 12),
    ratios: rows(data.ratios).slice(0, 60),
    top_ratios: data.top_ratios && typeof data.top_ratios === 'object' && !Array.isArray(data.top_ratios) ? data.top_ratios : {},
    shareholding_quarterly: rows(data.shareholding_quarterly).slice(0, 12),
    shareholding_yearly: rows(data.shareholding_yearly).slice(0, 8)
  };
  const statementRows = financials.quarterly_results.length + financials.profit_and_loss.length
    + financials.balance_sheet.length + financials.cash_flows.length;
  if (!statementRows) throw new Error('Fincrux returned no quarterly, P&L, balance-sheet or cash-flow statement rows. data keys: ' + Object.keys(data).slice(0, 15).join(', '));
  return {
    ticker: symbol,
    company: clean(payload.company),
    about: clean(data.about).slice(0, 3000),
    last_updated_at: safeDate(data.last_updated_at),
    statement_row_count: statementRows,
    financials
  };
}

async function getKeyRateLimit(db, keyId) {
  const [row] = await db.query(`
    SELECT evidence->>'rate_limited_until' AS until_at,
           evidence->>'rate_limit_retry_seconds' AS retry_seconds
    FROM wealth_stock_advisor_research_sources
    WHERE publisher='Fincrux' AND source_type='financial_statement'
      AND evidence->>'attempted_key'=$1
      AND NULLIF(evidence->>'rate_limited_until','')::timestamptz > now()
    ORDER BY retrieved_at DESC LIMIT 1
  `, [String(keyId)]);
  return row || null;
}

function retryAfterSeconds(payload) {
  const raw = String(payload?.retry_in || payload?.retry_after || '').trim();
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (match) return Math.max(1, Math.ceil(Number(match[1])));
  return null;
}

async function reserveDailySlot(db, ticker, url, dateKey, keyId) {
  const title = 'Financial statement API request — ' + ticker + ' — ' + dateKey;
  const rows = await db.query(`
    WITH quota_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtext('wealth-fincrux-daily:' || $3::text || ':' || $4::text))
    ), quota AS (
      SELECT count(*)::int AS used
      FROM wealth_stock_advisor_research_sources, quota_lock
      WHERE publisher='Fincrux'
        AND retrieved_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
        AND retrieved_at < ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata')
        AND right(url, length($4) + 5) = '#key-' || $4
    )
    INSERT INTO wealth_stock_advisor_research_sources
      (run_id,ticker,source_type,title,url,publisher,retrieved_at,excerpt,evidence,verification_status)
    SELECT NULL,$1,'financial_statement',$5,$2,'Fincrux',now(),
      'Reserved daily free-tier request; response validation pending.',
      jsonb_build_object('provider','Fincrux','request_date_ist',$3,'reservation',true,'account_key_id',$4),
      'unverified'
    FROM quota WHERE used < ${MAX_DAILY_REQUESTS}
    ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE
      SET title=EXCLUDED.title,retrieved_at=now(),excerpt=EXCLUDED.excerpt,
          evidence=EXCLUDED.evidence,verification_status='unverified'
      WHERE wealth_stock_advisor_research_sources.retrieved_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    RETURNING id
  `, [ticker, url, dateKey, keyId, title]);
  return rows[0]?.id || null;
}

// A reservation row is written before the request is sent. If the request then failed to record its outcome, the row
// is left looking like a stored snapshot with no figures in it, and the 30-day freshness check honours it — which is
// how five tickers were locked out until 23 December 2026. Release any such abandoned placeholder from an earlier IST
// day: it holds no data, so rejecting it loses nothing and lets the ticker be tried again.
export async function releaseAbandonedReservations(db) {
  const released = await db.query(`UPDATE wealth_stock_advisor_research_sources
    SET verification_status='rejected',
        evidence = evidence || jsonb_build_object('released', true,
          'released_reason', 'Reservation placeholder with no figures; released so the ticker can be requested again.')
    WHERE run_id IS NULL AND publisher=$1 AND source_type='financial_statement'
      AND verification_status IN ('unverified','verified')
      AND evidence ? 'reservation' AND NOT (evidence ? 'financials')
      AND retrieved_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    RETURNING upper(ticker) AS ticker`, [SOURCE]);
  return released.map(r => r.ticker);
}

export async function collectFincruxFinancials({ instrument, db, manual = false } = {}) {
  const ticker = clean(instrument?.symbol).toUpperCase();
  const result = {
    provider: SOURCE, ticker, status: 'skipped', request_limit_per_ist_day: MAX_DAILY_REQUESTS,
    statement_rows: 0, verification_status: 'unverified', error: null, attempted_keys: 0
  };
  const keys = await loadFincruxApiKeys(db);
  if (!keys.length) {
    result.reason = 'No Fincrux keys are configured. Add keys in Provider Health or set FINCRUX_API_KEY in the environment.';
    return result;
  }
  result.request_limit_per_ist_day = MAX_DAILY_REQUESTS * keys.length;
  if (!/^[A-Z0-9&.-]{1,30}$/.test(ticker)) {
    result.status = 'failed';
    result.error = 'Invalid NSE ticker.';
    return result;
  }
  const [cached] = await db.query(
    "SELECT retrieved_at FROM wealth_stock_advisor_research_sources WHERE run_id IS NULL AND upper(ticker)=upper($1) AND publisher='Fincrux' AND source_type='financial_statement' AND verification_status IN ('unverified','verified') ORDER BY retrieved_at DESC LIMIT 1",
    [ticker]
  );
  if (cached?.retrieved_at && Date.now() - Date.parse(cached.retrieved_at) < 30 * 86400000) {
    result.status = 'skipped';
    result.reason = 'A Fincrux financial snapshot was already collected within the last 30 days.';
    return result;
  }
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sourceUrl = BASE + '/' + encodeURIComponent(ticker);
  if (!manual) {
    const [todayAttempt] = await db.query(`
      SELECT id, retrieved_at, verification_status, evidence->>'reservation' AS reservation
      FROM wealth_stock_advisor_research_sources
      WHERE publisher='Fincrux' AND source_type='financial_statement'
        AND upper(ticker)=upper($1)
        AND retrieved_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
        AND retrieved_at < ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata')
      ORDER BY retrieved_at DESC LIMIT 1
    `, [ticker]);
    if (todayAttempt) {
      result.status = 'skipped';
      result.reason = 'Fincrux was already attempted for this stock today (IST). Automatic runs never call the same ticker twice in one day; use an explicit manual refresh to override.';
      result.already_attempted_today = true;
      return result;
    }
  }
  let lastError = null, lastPayload = null, successful = null;\n  const rateLimitedKeys = [];
  const startedAt = Date.now();
  for (const key of keys) {
    const cooldown = await getKeyRateLimit(db, key.id);
    if (cooldown) {
      rateLimitedKeys.push({ label: key.label, until: cooldown.until_at, retry_seconds: Number(cooldown.retry_seconds || 0) });
      result.reason = 'A Fincrux key is temporarily rate-limited until ' + cooldown.until_at + '; continuing with other enabled keys.';
      continue;
    }
    const reservationUrl = sourceUrl + '#key-' + encodeURIComponent(key.id);
    const reservationId = await reserveDailySlot(db, ticker, reservationUrl, dateKey, encodeURIComponent(key.id));
    if (!reservationId) {
      result.reason = 'This Fincrux API key has used its five-request daily allowance, or this ticker was already attempted with this key today. Other enabled keys are checked independently.';
      continue;
    }
    result.attempted_keys++;
    let payload = null, responseStatus = null;
    try {
      const response = await fetch(sourceUrl + '?api_key=' + encodeURIComponent(key.value), {
        headers: { Accept: 'application/json', 'User-Agent': 'WealthPersonalStockResearch/1.0' },
        signal: timeout(12000)
      });
      responseStatus = response.status;
      payload = await response.json().catch(() => null);
      lastPayload = payload;
      if (!response.ok) throw new Error('Fincrux HTTP ' + response.status + '.');
      if (!payload) throw new Error('Fincrux returned invalid JSON.');
      const normalized = normalizeFincruxFinancials(payload, ticker);
      await recordApiCall(db, { provider: SOURCE, endpoint: sourceUrl, ticker, httpStatus: response.status, ok: true,
        durationMs: Date.now() - startedAt, payload, bytes: JSON.stringify(payload || {}).length, usable: true });
      successful = { key, reservationId, normalized };
      break;
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 240);\n      const retrySeconds = responseStatus === 429 ? retryAfterSeconds(payload) : null;\n      const rateLimitedUntil = retrySeconds ? new Date(Date.now() + retrySeconds * 1000).toISOString() : null;\n      if (responseStatus === 429) rateLimitedKeys.push({ label: key.label, until: rateLimitedUntil, retry_seconds: retrySeconds });
      await recordApiCall(db, { provider: SOURCE, endpoint: sourceUrl, ticker, httpStatus: responseStatus, ok: false,
        durationMs: Date.now() - startedAt, payload, bytes: payload ? JSON.stringify(payload).length : null, usable: false, error: lastError });
      const salvage = { provider: SOURCE, request_date_ist: dateKey, request_failed: true, attempted_key: key.id, error: lastError,\n        ...(retrySeconds ? { rate_limit_retry_seconds: retrySeconds, rate_limited_until: rateLimitedUntil } : {}),
        response_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
        data_keys: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? Object.keys(payload.data).slice(0, 30) : [],
        partial: {} };
      for (const section of ['about', 'ratios', 'top_ratios', 'shareholding_quarterly', 'shareholding_yearly', 'last_updated_at']) {
        const value = payload?.data?.[section];
        if (value !== undefined && value !== null) salvage.partial[section] = value;
      }
      try {
        await db.query(`
          UPDATE wealth_stock_advisor_research_sources
          SET title=$2::text,retrieved_at=now(),excerpt=$3::text,evidence=$4::jsonb,verification_status='rejected'
          WHERE id=$1
        `, [reservationId, 'Fincrux request failed — ' + ticker,
          (lastError + (salvage.data_keys.length ? ' Response carried: ' + salvage.data_keys.join(', ') + '.' : '')).slice(0, 1000),
          JSON.stringify(salvage)]);
      } catch (writeError) {
        console.error('[stock-advisor-fincrux] could not record the failed key attempt', writeError?.message || writeError);
      }
    }
  }
  if (!successful) {
    result.status = lastError ? 'failed' : 'skipped';
    result.error = lastError || null;
    result.reason = lastError ? 'All available Fincrux keys failed; tried ' + result.attempted_keys + ' key(s). Last error: ' + lastError : result.reason || 'All configured Fincrux keys have exhausted their individual daily allowances.';
    result.response_keys = lastPayload && typeof lastPayload === 'object' ? Object.keys(lastPayload).slice(0, 20) : [];
    result.data_keys = lastPayload?.data && typeof lastPayload.data === 'object' && !Array.isArray(lastPayload.data) ? Object.keys(lastPayload.data).slice(0, 30) : [];
    return result;
  }

  const { normalized, reservationId, key } = successful;
  const retrievedAt = new Date().toISOString();
  const evidence = {
    provider: SOURCE, endpoint: sourceUrl, ticker: normalized.ticker, company: normalized.company, about: normalized.about,
    last_updated_at: normalized.last_updated_at, financials: normalized.financials,
    statement_row_count: normalized.statement_row_count, retrieved_at: retrievedAt,
    key_source: key.source, key_label: key.label,
    verification_note: 'Third-party structured financial data. Stored as unverified until key figures are checked against the linked official exchange/company filings. Must not satisfy the verified financial_statement evidence gate.'
  };
  const excerpt = [
    normalized.company || ticker, normalized.statement_row_count + ' statement rows returned.',
    'Quarterly results: ' + normalized.financials.quarterly_results.length,
    'P&L: ' + normalized.financials.profit_and_loss.length,
    'Balance sheet: ' + normalized.financials.balance_sheet.length,
    'Cash flow: ' + normalized.financials.cash_flows.length,
    normalized.last_updated_at ? 'Provider data updated ' + normalized.last_updated_at + '.' : 'Provider update date not supplied.'
  ].join(' ');
  await db.query(`
    UPDATE wealth_stock_advisor_research_sources
    SET title=$2,published_at=$3::timestamptz,retrieved_at=$4::timestamptz,
        excerpt=$5,evidence=$6::jsonb,verification_status='unverified'
    WHERE id=$1
  `, [reservationId, 'Financial statements — ' + (normalized.company || ticker), normalized.last_updated_at, retrievedAt, excerpt, JSON.stringify(evidence)]);
  result.status = 'stored_unverified';
  result.statement_rows = normalized.statement_row_count;
  result.last_updated_at = normalized.last_updated_at;
  result.source_url = sourceUrl;
  result.key_label = key.label;\n  result.rate_limited_keys = rateLimitedKeys;
  result.attempted_keys = result.attempted_keys;
  return result;
}
