import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNseXbrl } from '../../api/_lib/stock-advisor-nse-xbrl-parser.js';

const sample = readFileSync(new URL('./fixtures/nse-integrated-filing-sample.xml', import.meta.url), 'utf8');
const bankSample = readFileSync(new URL('./fixtures/nse-banking-sample.xml', import.meta.url), 'utf8');

test('NSE XBRL sample: period and headline figures come from the OneD current-period context', () => {
  const parsed = parseNseXbrl(sample);
  assert.equal(parsed.period, '2026-09');
  assert.equal(parsed.period_start, '2026-07-01');
  assert.equal(parsed.period_end, '2026-09-30');
  assert.equal(parsed.context_ref, 'OneD');
  assert.equal(parsed.symbol, 'TESTCO');
  assert.equal(parsed.figures.revenue.value, 1250000);
  assert.equal(parsed.figures.profit_before_tax.value, 345000);
  assert.equal(parsed.figures.net_profit.value, 256000);
  assert.equal(parsed.figures.eps.value, 1.25);
  assert.equal(parsed.figures.total_income.value, 1300000);
  assert.equal(parsed.figures.total_assets.value, 5000000);
  assert.equal(parsed.figures.total_equity.value, 2500000);
  assert.equal(parsed.figures.operating_cash_flow.value, 400000);
  assert.equal(parsed.elements.revenue, 'in-capmkt:RevenueFromOperations');
  assert.equal(parsed.elements.profit_before_tax, 'in-capmkt:ProfitBeforeTax');
  assert.equal(parsed.elements.net_profit, 'in-capmkt:ProfitLossForPeriod');
  assert.equal(parsed.elements.eps, 'in-capmkt:BasicEarningsLossPerShareFromContinuingOperations');
  assert.equal(parsed.elements.total_assets, 'in-capmkt:Assets');
  assert.equal(parsed.elements.total_equity, 'in-capmkt:Equity');
  assert.equal(parsed.elements.operating_cash_flow, 'in-capmkt:NetCashFlowsFromUsedInOperatingActivities');
  assert.equal(parsed.facts_read, 8);
});


test('banking taxonomy facts use InterestEarned and the banking net-profit/EPS element variants', () => {
  const parsed = parseNseXbrl(bankSample);
  assert.equal(parsed.period, '2026-09');
  assert.equal(parsed.symbol, 'BANKCO');
  assert.equal(parsed.figures.interest_earned.value, 1000000);
  assert.equal(parsed.figures.revenue, undefined, 'interest earned is not relabelled as revenue');
  assert.equal(parsed.figures.profit_before_tax.value, 300000);
  assert.equal(parsed.figures.net_profit.value, 220000);
  assert.equal(parsed.figures.eps.value, 4.2);
  assert.equal(parsed.elements.net_profit, 'in-capmkt:ProfitLossForThePeriod');
  assert.equal(parsed.elements.eps, 'in-capmkt:BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations');
});

test('the parser rejects non-XBRL, malformed and entity-bearing documents', () => {
  assert.throws(() => parseNseXbrl('<html><body>not an XBRL filing</body></html>'), /not an XBRL instance/);
  assert.throws(() => parseNseXbrl('<xbrl><context id="x"></xbrl>'), /no usable contexts or numeric facts/);
  assert.throws(() => parseNseXbrl('<!DOCTYPE x [<!ENTITY a "b">]><xbrl/>'), /DTD and entity declarations/);
});
