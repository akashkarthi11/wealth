// Stock Advisor: verify a company's financial statements by PERIOD MATCH with an official NSE results announcement (owner's rule, 2026-11-23).
// The Fincrux snapshot says which quarter it reports; if an NSE "Financial results" announcement for the same company mentions that same
// period, the statement is marked verified. This checks the period only: the individual figures are NOT compared against the filing,
// and the stored evidence says so. Nothing is verified without both a Fincrux snapshot and an NSE announcement for the same period.
// The announcement must be about this company (its title begins with the company name or symbol), and the Fincrux period must be the newest
// one NSE has announced for the company; a stale snapshot is never verified by an older announcement.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const ym = (y, m) => (m >= 1 && m <= 12 && y >= 2000 && y <= 2100 ? y + '-' + String(m).padStart(2, '0') : null);
const monthOf = s => MONTHS[String(s).slice(0, 3).toLowerCase()];

// Indian fiscal quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar; FY27 ends March 2027.
export function fiscalQuarterEnd(q, fy) {
  const quarter = Number(q), year = String(fy).length === 2 ? 2000 + Number(fy) : Number(fy);
  if (![1, 2, 3, 4].includes(quarter) || !Number.isFinite(year)) return null;
  return quarter === 4 ? ym(year, 3) : ym(year - 1, [6, 9, 12][quarter - 1]);
}

// Every reporting period (as 'YYYY-MM') mentioned in a piece of text. Dates are read the Indian way (day first).
export function periodsIn(text) {
  const t = String(text ?? ''), out = new Set();
  const add = v => { if (v) out.add(v); };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(ym(+m[1], +m[2]));
  for (const m of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) if (+m[1] >= 1 && +m[1] <= 31) add(ym(+m[3], +m[2]));
  for (const m of t.matchAll(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?[-\\s]+' + MON + '[-,\\s]+(\\d{4})\\b', 'gi'))) add(ym(+m[3], monthOf(m[2])));
  for (const m of t.matchAll(new RegExp('\\b' + MON + '[-\\s,]+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(\\d{4})\\b', 'gi'))) add(ym(+m[2], monthOf(m[1])));
  for (const m of t.matchAll(/\bQ([1-4])\s*[-]?\s*FY\s*'?(\d{4}|\d{2})\b/gi)) add(fiscalQuarterEnd(m[1], m[2]));
  return out;
}

// The latest quarter a Fincrux snapshot reports, read from the labels and values of its quarterly rows (any layout).
export function latestFincruxPeriod(evidence) {
  const rows = Array.isArray(evidence?.financials?.quarterly_results) ? evidence.financials.quarterly_results : [];
  const found = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      for (const p of periodsIn(k)) found.add(p);
      if (typeof v === 'string' && v.length <= 60) for (const p of periodsIn(v)) found.add(p);
    }
  }
  return [...found].sort().pop() || null;
}

// Words that may follow the company name at the start of a results announcement. Anything else after the name (for example "Finance" in
// "Tata Motors Finance Limited") means the announcement is about a different company that merely shares the name.
const AFTER_NAME = new Set(['financial', 'results', 'result', 'unaudited', 'audited', 'standalone', 'consolidated', 'outcome', 'quarter', 'quarterly', 'half', 'year', 'annual', 'for', 'board', 'submission', 'intimation', 'statement', 'statements']);
const norm = s => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !['limited', 'ltd', 'pvt', 'private'].includes(w)).join(' ');
// Is this announcement title about THIS company: it must begin with the company name (or the exchange symbol) and continue with a results word.
export function announcementIsFor(title, ticker, name) {
  const text = norm(title);
  return [norm(name), norm(ticker)].filter(Boolean).some(who => text === who || (text.startsWith(who + ' ') && AFTER_NAME.has(text.slice(who.length + 1).split(' ')[0])));
}
// A reporting period cannot end after the announcement that reports it was published, so later dates in the text (meeting dates) are ignored.
export function periodsPublishedBy(text, published) {
  const all = [...periodsIn(text)], by = published ? new Date(published).toISOString().slice(0, 7) : null;
  return by ? all.filter(p => p <= by) : all;
}

// Verify the ticker's newest unverified Fincrux statement. db.query returns rows. Idempotent; returns what happened.
// name is the company name saved for the instrument; without it only an announcement that begins with the exchange symbol counts.
export async function verifyFinancialStatements(db, ticker, { now = Date.now(), name = '' } = {}) {
  const symbol = String(ticker || '').trim().toUpperCase();
  const [fx] = await db.query(`SELECT id, evidence, retrieved_at FROM wealth_stock_advisor_research_sources
    WHERE run_id IS NULL AND upper(ticker)=$1 AND publisher='Fincrux' AND source_type='financial_statement' AND verification_status IN ('unverified','verified')
    ORDER BY retrieved_at DESC LIMIT 1`, [symbol]);
  if (!fx) return { ticker: symbol, status: 'no_fincrux_data' };
  const ev = typeof fx.evidence === 'string' ? JSON.parse(fx.evidence) : fx.evidence || {};
  if (ev.verification && ev.verification.rule === 'period_match_nse') return { ticker: symbol, status: 'already_verified', period: ev.verification.period };
  const period = latestFincruxPeriod(ev);
  if (!period) return { ticker: symbol, status: 'no_period_in_fincrux_data' };
  const nse = await db.query(`SELECT id, title, url, excerpt, published_at FROM wealth_stock_advisor_research_sources
    WHERE upper(ticker)=$1 AND publisher='NSE' AND source_type='financial_statement' AND evidence->>'feed_label'='Financial results'
      AND published_at IS NOT NULL AND published_at > $2::timestamptz ORDER BY published_at DESC LIMIT 60`, [symbol, new Date(now - 400 * 864e5).toISOString()]);
  const own = nse.filter(r => announcementIsFor(r.title, symbol, name)).map(r => ({ ...r, latest: periodsPublishedBy((r.title || '') + ' ' + (r.excerpt || ''), r.published_at).sort().pop() || null }));
  const newest = own.map(r => r.latest).filter(Boolean).sort().pop() || null;
  if (newest && period < newest) return { ticker: symbol, status: 'fincrux_older_than_nse', period, nse_latest_period: newest };
  const hit = own.find(r => r.latest === period);
  if (!hit) return { ticker: symbol, status: 'no_matching_nse_announcement', period, nse_announcements_checked: nse.length, nse_announcements_for_company: own.length };
  const verification = { rule: 'period_match_nse', period, nse_source_id: hit.id, nse_url: hit.url, nse_title: String(hit.title || '').slice(0, 200), verified_at: new Date(now).toISOString(),
    note: 'Verified by matching the reporting period to an official NSE results announcement. The individual figures were not compared against the filing.' };
  const upd = await db.query(`UPDATE wealth_stock_advisor_research_sources SET verification_status='verified', evidence = evidence || jsonb_build_object('verification', $2::jsonb)
    WHERE id=$1 AND verification_status='unverified' RETURNING id`, [fx.id, JSON.stringify(verification)]);
  return { ticker: symbol, status: upd.length ? 'verified' : 'already_verified', period, nse_url: hit.url };
}
