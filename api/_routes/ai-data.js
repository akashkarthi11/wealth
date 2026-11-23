import { sql, json, sessionUser } from '../_lib.js';
import { queueCounts } from '../_lib/job-queue.js';
import { summarizeItems, stepOf } from '../_lib/stock-advisor-data-collection.js';

// GET /api/ai-data[?run=<id>&ticker=<SYMBOL>&provider=<name>]  (admin only, read only)
// What the scheduled "Stock Advisor data collection" job fetched: its runs with timings, each provider call of one run,
// what is stored for the advisor right now, and which holdings it cannot collect for.
// The function limit is the maxDuration of api/router.js in vercel.json; every route runs inside it.
const FUNCTION_LIMIT_SECONDS = 60;
const STALLED_AFTER_MS = 3 * 60 * 1000;

async function adminUser(req) {
  const uid = await sessionUser(req);
  if (!uid) return null;
  const [user] = await sql.query('SELECT role FROM wealth_users WHERE id=$1', [uid]);
  return user?.role === 'admin' ? uid : null;
}
const obj = v => (typeof v === 'string' ? JSON.parse(v) : v) || {};
const count = (s, k) => Number(s[k] || 0);

function runRow(r, now, open = 0) {
  const s = obj(r.summary);
  const started = new Date(r.started_at).getTime(), finished = r.finished_at ? new Date(r.finished_at).getTime() : null; // the driver may return Date objects or strings
  const stalled = r.status === 'running' && !open && now - started > STALLED_AFTER_MS; // a run with tasks still queued is waiting, not stalled
  return {
    id: r.id, status: stalled ? 'stalled' : r.status, started_at: r.started_at, finished_at: r.finished_at, error: r.error,
    duration_ms: finished ? finished - started : (s.duration_ms ?? null), work_ms: s.work_ms ?? null,
    counts: { instruments: count(s, 'instruments'), feeds: count(s, 'feeds'), announcements: count(s, 'announcements'), nav_updated: count(s, 'nav_updated'),
      market_data_updated: count(s, 'market_data_updated'), financials_unverified: count(s, 'financials_unverified'), financials_verified: count(s, 'financials_verified'),
      failed: count(s, 'failed'), skipped: count(s, 'skipped') },
    steps: Array.isArray(s.steps) ? s.steps : [],
  };
}

export default async function handler(req, res) {
  try {
    if (!sql) return json(res, 503, { error: 'Database is not configured' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (!(await adminUser(req))) return json(res, 403, { error: 'Admin sign-in required' });
    const url = new URL(req.url || '/', 'http://x');
    const wantRun = String(url.searchParams.get('run') || '');
    const ticker = String(url.searchParams.get('ticker') || '').trim().toUpperCase().slice(0, 40);
    const provider = String(url.searchParams.get('provider') || '').trim().slice(0, 60);
    const verification = String(url.searchParams.get('verification') || '').trim().slice(0, 40);
    const sourceType = String(url.searchParams.get('source_type') || '').trim().slice(0, 60);
    const now = Date.now();

    const rawRuns = await sql.query(`SELECT id,started_at,finished_at,status,summary,error FROM wealth_stock_advisor_data_collection_runs
      ORDER BY started_at DESC LIMIT 15`);
    const openRows = rawRuns.length ? await sql.query(`SELECT payload->>'collection_run_id' AS rid, count(*)::int AS n FROM wealth_job_queue
      WHERE status IN ('pending','running') AND payload->>'collection_run_id'=ANY($1::text[]) GROUP BY 1`, [rawRuns.map(r => String(r.id))]) : [];
    const openBy = new Map(openRows.map(r => [r.rid, Number(r.n)]));
    const runs = rawRuns.map(r => runRow(r, now, openBy.get(String(r.id)) || 0));
    const selected = runs.find(r => r.id === wantRun) || runs[0] || null;
    if (selected) {
      // A run made through the job queue: every task is a queue item, so the steps (including the ones still waiting) and the counts so far come from the items.
      const items = await sql.query(`SELECT handler_key,task,status,payload,result,error,started_at,finished_at FROM wealth_job_queue
        WHERE payload->>'collection_run_id'=$1 ORDER BY priority,created_at,id`, [selected.id]);
      if (items.length) {
        const so_far = summarizeItems(items, { instruments: selected.counts.instruments });
        selected.steps = items.map(stepOf);
        selected.progress = { done: items.filter(i => i.status === 'done' || i.status === 'failed').length, total: items.length };
        selected.counts = { ...selected.counts, instruments: selected.counts.instruments, feeds: so_far.feeds, announcements: so_far.announcements, nav_updated: so_far.nav_updated,
          market_data_updated: so_far.market_data_updated, financials_unverified: so_far.financials_unverified, financials_verified: so_far.financials_verified, failed: so_far.failed, skipped: so_far.skipped };
        selected.work_ms = selected.steps.reduce((s, x) => s + (x.ms || 0), 0);
      }
    }

    const stored = await sql.query(`SELECT COALESCE(publisher,'Unknown') AS publisher, source_type, verification_status, count(*)::int AS n,
        count(DISTINCT upper(ticker))::int AS tickers, max(retrieved_at) AS last_retrieved
      FROM wealth_stock_advisor_research_sources WHERE run_id IS NULL
      GROUP BY 1,2,3 ORDER BY 1,2,3`);

    const where = ['run_id IS NULL'], params = [];
    if (ticker) { params.push(ticker); where.push('upper(ticker)=$' + params.length); }
    if (provider) { params.push(provider); where.push('publisher=$' + params.length); }
    if (verification) { params.push(verification); where.push('verification_status=$' + params.length); }
    if (sourceType) { params.push(sourceType); where.push('source_type=$' + params.length); }
    const sources = await sql.query(`SELECT id,ticker,source_type,title,url,publisher,published_at,retrieved_at,verification_status,left(COALESCE(excerpt,''),240) AS excerpt
      FROM wealth_stock_advisor_research_sources WHERE ${where.join(' AND ')} ORDER BY retrieved_at DESC LIMIT 100`, params);

    // Holdings the job cannot collect for: it only reads active holdings whose instrument has a symbol AND a saved price-source symbol.
    const notCollected = await sql.query(`SELECT DISTINCT i.name, i.symbol, i.asset_class,
        CASE WHEN i.symbol IS NULL THEN 'no symbol saved' WHEN i.price_source_symbol IS NULL THEN 'no price-source symbol saved' ELSE 'not an Indian equity or mutual fund' END AS reason
      FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
      WHERE h.status='active' AND (i.symbol IS NULL OR i.price_source_symbol IS NULL OR i.asset_class NOT IN ('indian_equity','indian_mutual_fund'))
      ORDER BY i.name LIMIT 100`);

    const providers = [...new Set(stored.map(r => r.publisher))].sort();
    const source_types = [...new Set(stored.map(r => r.source_type))].sort();
    const verification_statuses = [...new Set(stored.map(r => r.verification_status))].sort();
    return json(res, 200, { function_limit_seconds: FUNCTION_LIMIT_SECONDS, runs, selected, stored, providers, sources, not_collected: notCollected, queue: await queueCounts(sql), filter: { ticker, provider, verification, source_type: sourceType }, source_types, verification_statuses });
  } catch (error) {
    console.error('[ai-data]', error?.message || error);
    return json(res, 500, { error: 'Could not load AI data.' });
  }
}
 + params.length); }
    if (verification) { params.push(verification); where.push('verification_status=
    const sources = await sql.query(`SELECT id,ticker,source_type,title,url,publisher,published_at,retrieved_at,verification_status,left(COALESCE(excerpt,''),240) AS excerpt
      FROM wealth_stock_advisor_research_sources WHERE ${where.join(' AND ')} ORDER BY retrieved_at DESC LIMIT 100`, params);

    // Holdings the job cannot collect for: it only reads active holdings whose instrument has a symbol AND a saved price-source symbol.
    const notCollected = await sql.query(`SELECT DISTINCT i.name, i.symbol, i.asset_class,
        CASE WHEN i.symbol IS NULL THEN 'no symbol saved' WHEN i.price_source_symbol IS NULL THEN 'no price-source symbol saved' ELSE 'not an Indian equity or mutual fund' END AS reason
      FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
      WHERE h.status='active' AND (i.symbol IS NULL OR i.price_source_symbol IS NULL OR i.asset_class NOT IN ('indian_equity','indian_mutual_fund'))
      ORDER BY i.name LIMIT 100`);

    const providers = [...new Set(stored.map(r => r.publisher))].sort();
    return json(res, 200, { function_limit_seconds: FUNCTION_LIMIT_SECONDS, runs, selected, stored, providers, source_types: [...new Set(stored.map(r => r.source_type))].sort(), verification_statuses: [...new Set(stored.map(r => r.verification_status))].sort(), sources, not_collected: notCollected, queue: await queueCounts(sql), filter: { ticker, provider, verification, source_type: sourceType } });
  } catch (error) {
    console.error('[ai-data]', error?.message || error);
    return json(res, 500, { error: 'Could not load AI data.' });
  }
}
 + params.length); }
    if (sourceType) { params.push(sourceType); where.push('source_type=
    const sources = await sql.query(`SELECT id,ticker,source_type,title,url,publisher,published_at,retrieved_at,verification_status,left(COALESCE(excerpt,''),240) AS excerpt
      FROM wealth_stock_advisor_research_sources WHERE ${where.join(' AND ')} ORDER BY retrieved_at DESC LIMIT 100`, params);

    // Holdings the job cannot collect for: it only reads active holdings whose instrument has a symbol AND a saved price-source symbol.
    const notCollected = await sql.query(`SELECT DISTINCT i.name, i.symbol, i.asset_class,
        CASE WHEN i.symbol IS NULL THEN 'no symbol saved' WHEN i.price_source_symbol IS NULL THEN 'no price-source symbol saved' ELSE 'not an Indian equity or mutual fund' END AS reason
      FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
      WHERE h.status='active' AND (i.symbol IS NULL OR i.price_source_symbol IS NULL OR i.asset_class NOT IN ('indian_equity','indian_mutual_fund'))
      ORDER BY i.name LIMIT 100`);

    const providers = [...new Set(stored.map(r => r.publisher))].sort();
    return json(res, 200, { function_limit_seconds: FUNCTION_LIMIT_SECONDS, runs, selected, stored, providers, sources, not_collected: notCollected, queue: await queueCounts(sql), filter: { ticker, provider } });
  } catch (error) {
    console.error('[ai-data]', error?.message || error);
    return json(res, 500, { error: 'Could not load AI data.' });
  }
}
 + params.length); }
    const sources = await sql.query(`SELECT id,ticker,source_type,title,url,publisher,published_at,retrieved_at,verification_status,left(COALESCE(excerpt,''),240) AS excerpt
      FROM wealth_stock_advisor_research_sources WHERE ${where.join(' AND ')} ORDER BY retrieved_at DESC LIMIT 100`, params);

    // Holdings the job cannot collect for: it only reads active holdings whose instrument has a symbol AND a saved price-source symbol.
    const notCollected = await sql.query(`SELECT DISTINCT i.name, i.symbol, i.asset_class,
        CASE WHEN i.symbol IS NULL THEN 'no symbol saved' WHEN i.price_source_symbol IS NULL THEN 'no price-source symbol saved' ELSE 'not an Indian equity or mutual fund' END AS reason
      FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
      WHERE h.status='active' AND (i.symbol IS NULL OR i.price_source_symbol IS NULL OR i.asset_class NOT IN ('indian_equity','indian_mutual_fund'))
      ORDER BY i.name LIMIT 100`);

    const providers = [...new Set(stored.map(r => r.publisher))].sort();
    return json(res, 200, { function_limit_seconds: FUNCTION_LIMIT_SECONDS, runs, selected, stored, providers, sources, not_collected: notCollected, queue: await queueCounts(sql), filter: { ticker, provider } });
  } catch (error) {
    console.error('[ai-data]', error?.message || error);
    return json(res, 500, { error: 'Could not load AI data.' });
  }
}
