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
