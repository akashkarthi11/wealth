const BASE = 'https://api.tejhq.dev/v1';
const SOURCE = 'TejHQ NSE EOD';
const timeout = ms => AbortSignal.timeout(ms);
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'WealthPersonalStockResearch/1.0' },
    signal: timeout(12000)
  });
  if (!response.ok) throw new Error('TejHQ HTTP ' + response.status);
  return response.json();
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'rows', 'results', 'ohlcv']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}
function normalizeRow(row) {
  const date = String(row.date || row.trading_date || row.timestamp || '').slice(0, 10);
  const open = finite(row.open), high = finite(row.high), low = finite(row.low);
  const close = finite(row.close ?? row.adj_close ?? row.adjusted_close);
  const volume = finite(row.volume ?? row.total_traded_quantity);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![open, high, low, close].every(v => v != null && v > 0)) return null;
  return { date, open, high, low, close, volume };
}
function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1), out = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (const value of values.slice(period)) out.push(value * k + out[out.length - 1] * (1 - k));
  return out;
}
function indicators(rows) {
  const closes = rows.map(row => row.close);
  if (closes.length < 50) return null;
  const changes = closes.slice(1).map((value, index) => value - closes[index]);
  const gains = changes.slice(-14).map(value => Math.max(0, value));
  const losses = changes.slice(-14).map(value => Math.max(0, -value));
  const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
  const rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  const macdLine = fast.length && slow.length ? fast.slice(-slow.length).map((v, i) => v - slow[i]) : [];
  const signal = emaSeries(macdLine, 9);
  return {
    as_of: rows[rows.length - 1].date,
    observations: rows.length,
    close: closes[closes.length - 1],
    sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
    rsi14: Number(rsi14.toFixed(2)),
    macd: macdLine.length ? Number(macdLine[macdLine.length - 1].toFixed(4)) : null,
    macd_signal: signal.length ? Number(signal[signal.length - 1].toFixed(4)) : null,
    volume: rows[rows.length - 1].volume,
    average_volume20: sma(rows.slice(-20).map(row => row.volume || 0), 20)
  };
}

export async function collectTejHqEquityEvidence({ ticker, name, runId, db }) {
  const result = { provider: 'TejHQ', ticker: String(ticker || '').toUpperCase(), fetched_at: new Date().toISOString(), status: 'unavailable', observations: 0, price_stored: false, technicals_stored: false, error: null };
  try {
    const symbol = result.ticker;
    if (!/^[A-Z0-9&.-]{1,30}$/.test(symbol)) throw new Error('Invalid NSE symbol.');
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
    const payload = await getJson(BASE + '/ohlcv/nse/' + encodeURIComponent(symbol) + '?from=' + fromDate + '&to=' + to);
    const history = rowsFrom(payload).map(normalizeRow).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    const deduped = [...new Map(history.map(row => [row.date, row])).values()].slice(-260);
    if (!deduped.length) throw new Error('TejHQ returned no valid NSE EOD rows for ' + symbol + '.');
    result.observations = deduped.length;

    const [instrument] = await db.query('SELECT id FROM wealth_instruments WHERE upper(symbol)=upper($1) LIMIT 1', [symbol]);
    if (instrument?.id) {
      for (const row of deduped) {
        await db.query(
          "INSERT INTO wealth_instrument_prices (instrument_id,as_of,source,price,fx_to_inr,fetched_at) VALUES ($1,$2::date + time '15:30',$3,$4,1,$5::timestamptz) ON CONFLICT (instrument_id,as_of,source) DO UPDATE SET price=EXCLUDED.price,fx_to_inr=EXCLUDED.fx_to_inr,fetched_at=EXCLUDED.fetched_at",
          [instrument.id, row.date, SOURCE, row.close, result.fetched_at]
        );
      }
      result.price_stored = true;
    }

    const latest = deduped[deduped.length - 1];
    const priceEvidence = {
      provider: 'TejHQ', exchange: 'NSE', ticker: symbol, company: String(name || symbol),
      data_type: 'end_of_day_ohlcv', currency: 'INR', latest, observations: deduped.length,
      first_date: deduped[0].date, last_date: latest.date, fetched_at: result.fetched_at,
      endpoint: '/v1/ohlcv/nse/' + symbol, limitations: ['End-of-day data only; not live or intraday.', 'Provider data may be delayed until the next morning IST.']
    };
    const priceUrl = 'https://api.tejhq.dev/v1/ohlcv/nse/' + encodeURIComponent(symbol);
    await db.query(
      "INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status) VALUES (NULL,$1,'market_price',$2,$3,'TejHQ',$4::timestamptz,$5::timestamptz,$6,$7::jsonb,'verified') ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=EXCLUDED.retrieved_at,excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'",
      [symbol, 'NSE end-of-day market price — ' + symbol, priceUrl, latest.date, result.fetched_at, 'Latest NSE close ₹' + latest.close + ' on ' + latest.date + '; ' + deduped.length + ' daily observations.', JSON.stringify(priceEvidence)]
    );

    const technical = indicators(deduped);
    if (technical) {
      const technicalEvidence = {
        provider: 'TejHQ derived calculation', exchange: 'NSE', ticker: symbol,
        methodology: 'Calculated by Wealth from daily NSE OHLCV close and volume observations; SMA20/50/200, RSI14 (simple 14-period gains/losses), MACD (12,26,9 EMA).',
        indicators: technical, source_observations: deduped.length, source_as_of: latest.date,
        fetched_at: result.fetched_at, no_intraday_data: true
      };
      const technicalUrl = 'https://api.tejhq.dev/v1/ohlcv/nse/' + encodeURIComponent(symbol) + '#technical-indicators';
      await db.query(
        "INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status) VALUES (NULL,$1,'technical_indicator',$2,$3,'TejHQ / Wealth',$4::timestamptz,$5::timestamptz,$6,$7::jsonb,'verified') ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=EXCLUDED.retrieved_at,excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'",
        [symbol, 'Technical indicators — ' + symbol, technicalUrl, latest.date, result.fetched_at, 'RSI14 ' + technical.rsi14 + '; SMA20 ' + technical.sma20 + '; SMA50 ' + technical.sma50 + '; SMA200 ' + (technical.sma200 ?? 'not available') + '; MACD ' + technical.macd + '.', JSON.stringify(technicalEvidence)]
      );
      result.technicals_stored = true;
      result.technical_indicators = technical;
    }
    result.latest_price = { close: latest.close, as_of: latest.date, source: SOURCE };
    result.status = 'ok';
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 240);
  }
  return result;
}
