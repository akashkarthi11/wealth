import { recordApiCall } from './api-audit.js';
import { announcementIsFor, periodsPublishedBy } from './stock-advisor-verify.js';
import { parseNseXbrl } from './stock-advisor-nse-xbrl-parser.js';

const API = 'https://www.nseindia.com/api/integrated-filing-results';
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; WealthStockAdvisor/1.0; +https://nseindia.com)';
const timeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
const safeNseUrl = value => {
  const text = String(value || '').trim();
  if (!/^https:\/\//i.test(text)) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'https:' || !['nsearchives.nseindia.com', 'nsearchives.nseindia.in', 'www.nseindia.com', 'www.nseindia.in'].includes(u.hostname)) return null;
  return u.toString();
};
const dayIst = value => {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const nseDate = value => {
  const m = String(value || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const month = months[m[2].toLowerCase()];
  return month ? m[3] + '-' + month + '-' + String(m[1]).padStart(2, '0') : null;
};
const nseTimestamp = value => {
  const m = String(value || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const month = months[m[2].toLowerCase()];
  if (!month) return null;
  return new Date(m[3] + '-' + month + '-' + String(m[1]).padStart(2, '0') + 'T' + String(m[4]).padStart(2, '0') + ':' + m[5] + ':' + m[6] + '+05:30').toISOString();
};
const nseDateParam = iso => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
};
const audit = (db, values) => recordApiCall(db, { provider: 'NSE XBRL', ...values });
function xbrlShapeProbe(xml, contentType) {
  const source = String(xml || '');
  const names = [...new Set([...source.matchAll(/<([A-Za-z_][\w:.-]*)\b/g)].map(m => m[1]))].slice(0, 120);
  const contextIds = [...new Set([...source.matchAll(/<(?:[\w.-]+:)?context\b[^>]*\bid=["']([^"']+)["']/gi)].map(m => m[1]))].slice(0, 40);
  const namespaces = [...source.matchAll(/\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*["']([^"']+)["']/g)]
    .map(m => ({ prefix: m[1] || '', uri: m[2] })).slice(0, 30);
  const rootElement = source.match(/<([A-Za-z_][\w:.-]*)\b/)?.[1] || null;
  return { content_type: contentType || '', document_kind: 'nse_filed_xbrl', byte_length: new TextEncoder().encode(source).byteLength,
    root_element: rootElement, namespaces, xml_element_names: names, context_ids: contextIds };
}

async function readLatestAnnouncement(db, ticker) {
  const rows = await db.query(`SELECT id,title,url,published_at,excerpt,evidence
    FROM wealth_stock_advisor_research_sources
    WHERE run_id IS NULL AND upper(ticker)=$1 AND publisher='NSE' AND source_type='financial_statement'
      AND evidence->>'feed_label'='Financial results'
    ORDER BY published_at DESC NULLS LAST,retrieved_at DESC LIMIT 1`, [String(ticker).toUpperCase()]);
  return rows[0] || null;
}
function chooseFiling(data, ticker, announcement) {
  if (!Array.isArray(data)) return { error: 'NSE API response shape changed: data is not an array.' };
  const observedKeys = data.length && data[0] && typeof data[0] === 'object' ? Object.keys(data[0]) : [];
  const requiredKeys = ['symbol','type','qe_Date','consolidated','xbrl'];
  const missingKeys = requiredKeys.filter(key => !observedKeys.includes(key));
  if (data.length && missingKeys.length) return { error: 'NSE filing row shape changed: missing ' + missingKeys.join(', ') + '; observed keys: ' + observedKeys.join(', '), observed_keys: observedKeys };
  const publishedDay = dayIst(announcement.published_at);
  const announcementPeriods = [...periodsPublishedBy(String(announcement.title || '') + ' ' + String(announcement.excerpt || ''), announcement.published_at)];
  const candidates = data.filter(row => {
    if (!row || typeof row !== 'object') return false;
    if (String(row.symbol || '').toUpperCase() !== String(ticker).toUpperCase()) return false;
    if (String(row.type || '') !== 'Integrated Filing- Financials') return false;
    if (!safeNseUrl(row.xbrl)) return false;
    const company = String(row.cmName || row.smName || '').trim();
    if (!announcementIsFor(announcement.title, ticker, company)) return false;
    const rowDay = nseDate(row.broadcast_Date || row.creation_Date);
    const exactPdf = safeNseUrl(row.pdf_attach) === safeNseUrl(announcement.url);
    if (!exactPdf && (!publishedDay || rowDay !== publishedDay)) return false;
    const period = nseDate(row.qe_Date)?.slice(0, 7) || null;
    if (!period || (announcementPeriods.length && !announcementPeriods.includes(period))) return false;
    return true;
  });
  if (!candidates.length) return { error: 'No NSE Integrated Filing XBRL record matched the stored Financial results announcement by ticker, company, filing date and reporting period.' };
  const consolidated = candidates.filter(r => String(r.consolidated || '').toLowerCase() === 'consolidated');
  const basisCandidates = consolidated.length ? consolidated : candidates;
  const filingTime = row => nseTimestamp(row.revised_Date) || nseTimestamp(row.creation_Date) || 0;
  basisCandidates.sort((a, b) => filingTime(b) - filingTime(a));
  return { filing: basisCandidates[0], matched_count: candidates.length };
}

export async function collectNseXbrlFinancialStatement({ instrument, db } = {}) {
  const ticker = String(instrument?.symbol || '').trim().toUpperCase();
  if (!ticker || !db?.query) return { ticker, status: 'failed', reason: 'A holding ticker and database connection are required.' };
  try {
    const announcement = await readLatestAnnouncement(db, ticker);
    if (!announcement) return { ticker, status: 'no_announcement', reason: 'No stored NSE Financial results announcement exists for this holding.' };
    const announcementUrl = safeNseUrl(announcement.url);
    if (!announcementUrl || !['nsearchives.nseindia.com', 'nsearchives.nseindia.in'].includes(new URL(announcementUrl).hostname)) {
      return { ticker, status: 'failed', reason: 'Stored announcement URL is not an allowed NSE archive URL.' };
    }

    // Audit the stored filing fetch before any document inspection.
    const pdfStarted = Date.now();
    try {
      const pdfResponse = await fetch(announcementUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1' }, signal: timeout() });
      const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
      const isPdf = new TextDecoder().decode(pdfBytes.slice(0, 5)) === '%PDF-';
      await audit(db, { endpoint: announcementUrl, ticker, httpStatus: pdfResponse.status, ok: pdfResponse.ok,
        durationMs: Date.now() - pdfStarted, bytes: pdfBytes.byteLength,
        payload: { content_type: pdfResponse.headers.get('content-type') || '', document_kind: 'stored_nse_announcement', byte_length: pdfBytes.byteLength },
        usable: pdfResponse.ok && isPdf, error: pdfResponse.ok ? (isPdf ? null : 'Stored NSE announcement did not return a PDF document.') : 'NSE announcement download failed.' });
      if (!pdfResponse.ok) return { ticker, status: 'failed', reason: 'NSE announcement download returned HTTP ' + pdfResponse.status + '.' };
      if (!isPdf) return { ticker, status: 'failed', reason: 'Stored NSE announcement did not return a PDF document.' };
    } catch (error) {
      await audit(db, { endpoint: announcementUrl, ticker, ok: false, durationMs: Date.now() - pdfStarted, error: String(error?.message || error) });
      return { ticker, status: 'failed', reason: 'NSE announcement download failed: ' + String(error?.message || error).slice(0, 160) };
    }

    // NSE's Integrated Filing endpoint is queried for the exact symbol and the stored announcement's IST date.
    const publishedDay = dayIst(announcement.published_at);
    const dateParam = nseDateParam(publishedDay);
    const params = new URLSearchParams({ index: 'equities', type: 'Integrated Filing- Financials', page: '1', size: '50', period_ended: 'all', symbol: ticker });
    if (dateParam) { params.set('from_date', dateParam); params.set('to_date', dateParam); }
    const metadataUrl = API + '?' + params.toString();
    const metadataStarted = Date.now();
    let metadataResponse, metadataRaw, metadata;
    try {
      metadataResponse = await fetch(metadataUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', Referer: 'https://www.nseindia.com/companies-listing/corporate-integrated-filing' }, signal: timeout() });
      metadataRaw = await metadataResponse.text();
      try { metadata = JSON.parse(metadataRaw); } catch { metadata = null; }
      await audit(db, { endpoint: metadataUrl, ticker, httpStatus: metadataResponse.status, ok: metadataResponse.ok,
        durationMs: Date.now() - metadataStarted, bytes: new TextEncoder().encode(metadataRaw).byteLength,
        payload: metadata && typeof metadata === 'object' ? metadata : { response_text: metadataRaw.slice(0, 300), content_type: metadataResponse.headers.get('content-type') || '' },
        usable: metadataResponse.ok && Array.isArray(metadata?.data), error: metadataResponse.ok ? null : 'NSE integrated filing metadata request failed.' });
      if (!metadataResponse.ok) return { ticker, status: 'failed', reason: 'NSE Integrated Filing API returned HTTP ' + metadataResponse.status + '.' };
      if (!metadata || typeof metadata !== 'object') return { ticker, status: 'failed', reason: 'NSE Integrated Filing API did not return valid JSON.' };
      if (!Array.isArray(metadata.data)) return { ticker, status: 'failed', reason: 'NSE API response shape changed: expected data array; received keys ' + Object.keys(metadata).slice(0, 20).join(', ') + '.' };
    } catch (error) {
      await audit(db, { endpoint: metadataUrl, ticker, ok: false, durationMs: Date.now() - metadataStarted, error: String(error?.message || error) });
      return { ticker, status: 'failed', reason: 'NSE Integrated Filing API request failed: ' + String(error?.message || error).slice(0, 160) };
    }

    const match = chooseFiling(metadata.data, ticker, announcement);
    if (!match.filing) return { ticker, status: 'no_xbrl_match', reason: match.error, api_keys: Object.keys(metadata), api_row_keys: match.observed_keys || Object.keys(metadata.data[0] || {}), api_data_count: metadata.data.length };
    const filing = match.filing, xbrlUrl = safeNseUrl(filing.xbrl);
    const xbrlStarted = Date.now();
    let xbrlResponse, xbrlText;
    try {
      xbrlResponse = await fetch(xbrlUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml, text/xml, application/octet-stream;q=0.9,*/*;q=0.1' }, signal: timeout() });
      xbrlText = await xbrlResponse.text();
      const xbrlBytes = new TextEncoder().encode(xbrlText).byteLength;
      await audit(db, { endpoint: xbrlUrl, ticker, httpStatus: xbrlResponse.status, ok: xbrlResponse.ok,
        durationMs: Date.now() - xbrlStarted, bytes: xbrlBytes,
        payload: xbrlShapeProbe(xbrlText, xbrlResponse.headers.get('content-type') || ''),
        usable: xbrlResponse.ok && /<(?:[\w.-]+:)?xbrl\b/i.test(xbrlText), error: xbrlResponse.ok ? null : 'NSE XBRL download failed.' });
      if (!xbrlResponse.ok) return { ticker, status: 'failed', reason: 'NSE XBRL download returned HTTP ' + xbrlResponse.status + '.', filing_url: announcementUrl, xbrl_url: xbrlUrl };
    } catch (error) {
      await audit(db, { endpoint: xbrlUrl, ticker, ok: false, durationMs: Date.now() - xbrlStarted, error: String(error?.message || error) });
      return { ticker, status: 'failed', reason: 'NSE XBRL download failed: ' + String(error?.message || error).slice(0, 160), filing_url: announcementUrl, xbrl_url: xbrlUrl };
    }

    let parsed;
    try { parsed = parseNseXbrl(xbrlText); }
    catch (error) { return { ticker, status: 'unparsed', reason: String(error?.message || error).slice(0, 240), filing_url: announcementUrl, xbrl_url: xbrlUrl }; }
    const apiPeriod = nseDate(filing.qe_Date)?.slice(0, 7) || null;
    if (apiPeriod && parsed.period !== apiPeriod) return { ticker, status: 'period_mismatch', reason: 'Parsed XBRL period ' + parsed.period + ' does not match NSE metadata period ' + apiPeriod + '.', filing_url: announcementUrl, xbrl_url: xbrlUrl };
    if (parsed.symbol && parsed.symbol !== ticker) return { ticker, status: 'ticker_mismatch', reason: 'XBRL document symbol ' + parsed.symbol + ' does not match holding ' + ticker + '.', filing_url: announcementUrl, xbrl_url: xbrlUrl };
    const company = String(filing.cmName || filing.smName || instrument.name || ticker);
    if (company && !announcementIsFor(announcement.title, ticker, company)) return { ticker, status: 'announcement_company_mismatch', reason: 'Stored announcement title does not identify NSE filing company ' + company + '.', filing_url: announcementUrl, xbrl_url: xbrlUrl };

    const evidence = {
      filing_url: announcementUrl,
      xbrl_url: xbrlUrl,
      filing_title: announcement.title,
      nse_symbol: ticker,
      company,
      reporting_period: parsed.period,
      reporting_period_start: parsed.period_start,
      reporting_period_end: parsed.period_end,
      context_ref: parsed.context_ref,
      nse_filing_id: String(filing.seq_Id || ''),
      filing_type: String(filing.type || ''),
      filing_subtype: String(filing.type_Sub || ''),
      revision_remark: String(filing.revision_Remark || ''),
      broadcast_date: String(filing.broadcast_Date || ''),
      creation_date: String(filing.creation_Date || ''),
      consolidated: String(filing.consolidated || ''),
      audited: String(filing.audited || ''),
      figures: parsed.figures,
      xbrl_elements_read: parsed.elements,
      note: 'Figures were read from the NSE-filed XBRL instance document. No third-party figures were used to verify this statement.',
      source: 'NSE Integrated Filing - Financials'
    };
    const title = 'NSE filed financial statement — ' + company + ' — ' + parsed.period + (filing.consolidated ? ' — ' + filing.consolidated : '');
    const publishedAt = nseTimestamp(filing.broadcast_Date) || nseTimestamp(filing.creation_Date) || announcement.published_at || null;
    const insertSql = `WITH actor AS MATERIALIZED (SELECT set_config('wealth.actor', 'agent', true))
      INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      SELECT NULL,$1,'financial_statement',$2,$3,'NSE',$4::timestamptz,now(),$5,$6::jsonb,'verified' FROM actor
      ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE SET
        source_type='financial_statement',title=EXCLUDED.title,publisher='NSE',published_at=EXCLUDED.published_at,
        retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'
      RETURNING id`;
    const saved = await db.query(insertSql, [ticker, title, xbrlUrl, publishedAt ? (publishedAt.includes('T') ? publishedAt : new Date(publishedAt).toISOString()) : null,
      'Filed NSE XBRL statement; reporting period ' + parsed.period + '; figures are in their reported units.', JSON.stringify(evidence)]);
    return { ticker, status: saved.length ? 'verified' : 'already_present', period: parsed.period, filing_url: announcementUrl, xbrl_url: xbrlUrl,
      consolidated: filing.consolidated || null, figures: Object.keys(parsed.figures), source_id: saved[0]?.id || null, matched_filings: match.matched_count };
  } catch (error) {
    return { ticker, status: 'failed', reason: String(error?.message || error).slice(0, 240) };
  }
}
