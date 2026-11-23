// NSE filing-period and announcement-matching helpers shared by the stock-advisor evidence collectors.
// Fincrux is secondary and must remain unverified. The compatibility verifier at the end of this file fails closed;
// only the NSE-filed XBRL parser may promote a financial statement to verified.

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

// Fincrux is a secondary source only. A period match to an NSE announcement does not verify its figures.
// Kept as a compatibility export so older callers fail closed rather than upgrading Fincrux evidence.
export async function verifyFinancialStatements(_db, ticker) {
  return { ticker: String(ticker || '').trim().toUpperCase(), status: 'disabled_fincrux_unverified',
    reason: 'Fincrux figures are never verified by period matching. Only figures parsed from the NSE-filed XBRL instance may be verified.' };
}
