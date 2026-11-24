import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectNseXbrlFinancialStatement } from '../../api/_lib/stock-advisor-nse-xbrl.js';

const sample = readFileSync(new URL('./fixtures/nse-integrated-filing-sample.xml', import.meta.url), 'utf8');
const announcementUrl = 'https://nsearchives.nseindia.com/corporate/TESTCO/financial-results.pdf';
const xbrlUrl = 'https://nsearchives.nseindia.in/corporate/xbrl/INTEGRATED_FILING_INDAS_100_10112026120000_WEB.xml';
const announcement = {
  id: 7, title: 'Test Company Limited - Financial Results for the quarter ended 30-09-2026',
  url: announcementUrl, published_at: '2026-11-10T10:00:00.000Z', excerpt: 'Unaudited financial results'
};
const metadata = { data: [{
  symbol: 'TESTCO', type: 'Integrated Filing- Financials', cmName: 'Test Company Limited',
  broadcast_Date: '10-Nov-2026 16:00:00', creation_Date: '10-Nov-2026 16:00:00',
  qe_Date: '30-SEP-2026', consolidated: 'Consolidated', audited: 'Un-Audited',
  pdf_attach: null, xbrl: xbrlUrl
}], page: 0, size: 20, totalCount: 1 };

function setup(xbrlText = sample) {
  const calls = [], sourceWrites = [], audits = [];
  const db = { query: async (sql, params = []) => {
    calls.push(sql);
    if (sql.includes('FROM wealth_stock_advisor_research_sources') && sql.includes("feed_label")) return [announcement];
    if (sql.includes('INSERT INTO wealth_api_audit')) { audits.push({ sql, params }); return []; }
    if (sql.includes('INSERT INTO wealth_stock_advisor_research_sources')) { sourceWrites.push({ sql, params }); return [{ id: 991 }]; }
    return [];
  }};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const value = String(url);
    if (value === announcementUrl) return new Response('%PDF-1.7 sample filing', { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (value.startsWith('https://www.nseindia.com/api/integrated-filing-results')) return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
    if (value === xbrlUrl) return new Response(xbrlText, { status: 200, headers: { 'content-type': 'application/xml' } });
    throw new Error('Unexpected NSE URL: ' + value);
  };
  return { db, calls, sourceWrites, audits, restore: () => { globalThis.fetch = originalFetch; } };
}

test('a parsed NSE filing is stored verified with the source filing URL, period and exact elements', async () => {
  const s = setup();
  try {
    const result = await collectNseXbrlFinancialStatement({ instrument: { symbol: 'TESTCO', name: 'Test Company Limited' }, db: s.db });
    assert.equal(result.status, 'verified');
    assert.equal(result.period, '2026-09');
    assert.deepEqual(result.figures.sort(), ['eps','net_profit','profit_before_tax','revenue','total_income','total_assets','total_equity','operating_cash_flow'].sort());
    assert.equal(s.audits.length, 3, 'PDF, NSE filing metadata and XBRL document requests are all audited');
    assert.ok(s.audits[2].params[7].includes('response_preview'), 'raw XBRL response metadata is audited before XML parsing');
    assert.match(JSON.parse(s.audits[2].params[10]).response_preview, /^<\?xml/);
    assert.equal(s.sourceWrites.length, 1);
    assert.match(s.sourceWrites[0].sql, /set_config\('wealth.actor', 'agent', true\)/);
    const evidence = JSON.parse(s.sourceWrites[0].params[5]);
    assert.equal(evidence.filing_url, announcementUrl);
    assert.equal(evidence.reporting_period, '2026-09');
    assert.equal(evidence.xbrl_elements_read.revenue, 'in-capmkt:RevenueFromOperations');
    assert.match(evidence.note, /read from the NSE-filed XBRL/);
  } finally { s.restore(); }
});

test('an XBRL document that cannot be parsed creates no verified research row', async () => {
  const s = setup('<xbrl><broken></xbrl>');
  try {
    const result = await collectNseXbrlFinancialStatement({ instrument: { symbol: 'TESTCO', name: 'Test Company Limited' }, db: s.db });
    assert.equal(result.status, 'unparsed');
    assert.match(result.reason, /no usable contexts or numeric facts/);
    assert.equal(s.audits.length, 3, 'the malformed XBRL response is audited before parsing');
    assert.equal(s.sourceWrites.length, 0, 'no row is inserted or marked verified');
  } finally { s.restore(); }
});

// NSE's RSS carries only recent announcements, so a quarter filed weeks ago has rolled off it. Requiring a stored
// announcement meant every holding returned "no_announcement" and the advisor answered DATA REQUIRED for all of them,
// outside the few days after results were announced. NSE's own filing index is queried by symbol, so it can identify
// the filing on its own; the announcement is a cross-check, and the figures still come only from the XBRL instance.
function setupNoAnnouncement() {
  const s = setup();
  const inner = s.db.query;
  s.db.query = async (sql, params = []) => {
    if (sql.includes('FROM wealth_stock_advisor_research_sources') && sql.includes('feed_label')) return [];
    return inner(sql, params);
  };
  return s;
}

test('with no stored announcement, the filing is still verified from the NSE index', async () => {
  const s = setupNoAnnouncement();
  try {
    const result = await collectNseXbrlFinancialStatement({ instrument: { symbol: 'TESTCO', name: 'Test Company Limited' }, db: s.db });
    assert.equal(result.status, 'verified', 'reason: ' + (result.reason || ''));
    assert.equal(result.period, '2026-09');
    const write = s.sourceWrites.at(-1);
    assert.ok(write, 'a research source was written');
    assert.match(write.sql, /'verified'/, 'stored verified: the figures came from the NSE-filed XBRL');
    const evidence = JSON.parse(write.params[5]);
    assert.equal(evidence.match_basis, 'nse_integrated_filing_index', 'the evidence records which route identified it');
    assert.equal(evidence.xbrl_url, xbrlUrl);
    assert.equal(evidence.filing_url, xbrlUrl, 'with no announcement PDF, the filing url is the XBRL instance');
  } finally { s.restore(); }
});

test('with no announcement the index is read for the whole history, not one day', async () => {
  const s = setupNoAnnouncement();
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { urls.push(String(url)); return realFetch(url); };
  try {
    await collectNseXbrlFinancialStatement({ instrument: { symbol: 'TESTCO' }, db: s.db });
    const index = urls.find(u => u.startsWith('https://www.nseindia.com/api/integrated-filing-results'));
    assert.ok(index, 'the filing index was queried');
    assert.ok(index.includes('symbol=TESTCO'), 'by symbol');
    assert.ok(!index.includes('from_date'), 'and with no single-day window, or an older quarter can never be found');
    assert.ok(!urls.includes(announcementUrl), 'no announcement PDF is fetched when there is no announcement');
  } finally { globalThis.fetch = realFetch; s.restore(); }
});

test('a stored announcement is still honoured, and still pins the query to its day', async () => {
  const s = setup();
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { urls.push(String(url)); return realFetch(url); };
  try {
    const result = await collectNseXbrlFinancialStatement({ instrument: { symbol: 'TESTCO' }, db: s.db });
    assert.equal(result.status, 'verified');
    const evidence = JSON.parse(s.sourceWrites.at(-1).params[5]);
    assert.equal(evidence.match_basis, 'stored_nse_announcement');
    assert.ok(urls.includes(announcementUrl), 'the announcement is still downloaded and checked');
    assert.ok(urls.find(u => u.includes('integrated-filing-results')).includes('from_date=10-11-2026'), 'still pinned to its day');
  } finally { globalThis.fetch = realFetch; s.restore(); }
});
