// NSE Integrated Filing - Financials XBRL parser.
// Reads the exchange's filed XML instance document only. It deliberately does not parse
// the readable iXBRL HTML or a rendered NSE web page.
const XML_TAG = /<([A-Za-z_][\w:.-]*)\b([^>]*\bcontextRef\s*=\s*["'][^"']+["'][^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const CONTEXT_TAG = /<(?:[\w.-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?context\s*>/gi;
const ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
const FACTS = Object.freeze({
  revenue: ['RevenueFromOperations', 'TotalRevenueFromOperations'],
  interest_earned: ['InterestEarned'],
  total_income: ['Income', 'TotalIncome'],
  profit_before_tax: ['ProfitBeforeTax', 'TotalProfitBeforeTax'],
  net_profit: ['ProfitLossForPeriod', 'ProfitLossForThePeriod', 'NetProfitLossForThePeriodFromContinuingOperations', 'NetProfitLossForPeriodFromContinuingOperations', 'ProfitLossAfterTaxAndExtraordinaryItems', 'ProfitLossAfterTax'],
  eps: ['BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', 'BasicEarningsLossPerShareFromContinuingOperations', 'BasicEarningsLossPerShare', 'BasicEarningsPerShare', 'EarningsPerShareBasic'],
  total_assets: ['Assets', 'TotalAssets'],
  total_equity: ['Equity', 'TotalEquity', 'ShareholdersFunds'],
  operating_cash_flow: ['NetCashFlowsFromUsedInOperatingActivities', 'NetCashFlowsFromOperatingActivities', 'NetCashFlowFromUsedInOperatingActivities']
});
const decodeXml = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const attrs = s => {
  const out = {};
  for (const m of String(s || '').matchAll(ATTR)) out[m[1].split(':').pop()] = decodeXml(m[3] ?? m[4] ?? '');
  return out;
};
const localName = s => String(s || '').split(':').pop();
const dateOk = s => { const value = String(s || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const time = Date.parse(value + 'T00:00:00Z'); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; };
const numeric = s => {
  const v = String(s || '').trim().replace(/,/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function parseContexts(xml) {
  const contexts = new Map();
  for (const m of String(xml).matchAll(CONTEXT_TAG)) {
    const a = attrs(m[1]), body = m[2], id = a.id;
    if (!id) continue;
    const start = body.match(/<(?:[\w.-]+:)?startDate\b[^>]*>\s*([^<]+)\s*<\//i)?.[1]?.trim();
    const end = body.match(/<(?:[\w.-]+:)?endDate\b[^>]*>\s*([^<]+)\s*<\//i)?.[1]?.trim();
    const instant = body.match(/<(?:[\w.-]+:)?instant\b[^>]*>\s*([^<]+)\s*<\//i)?.[1]?.trim();
    const dimensional = /<(?:[\w.-]+:)?(?:explicitMember|typedMember)\b/i.test(body);
    contexts.set(id, { id, start: start || null, end: end || instant || null, instant: !!instant, dimensional });
  }
  return contexts;
}
function parseFacts(xml) {
  const facts = [];
  XML_TAG.lastIndex = 0;
  for (const m of String(xml).matchAll(XML_TAG)) {
    const a = attrs(m[2]), name = localName(m[1]), raw = decodeXml(m[3].replace(/<[^>]+>/g, '').trim());
    if (!a.contextRef || a.nil === 'true' || a.nil === '1' || !raw) continue;
    let value = numeric(raw);
    if (value === null) continue;
    if (a.scale && Number.isFinite(Number(a.scale))) value *= Math.pow(10, Number(a.scale));
    if (a.sign === '-' || a.sign === '−') value = -Math.abs(value);
    facts.push({ name, qualified_name: m[1], context_ref: a.contextRef, unit_ref: a.unitRef || null, decimals: a.decimals || null, raw_value: raw, value });
  }
  return facts;
}
function dateDurationDays(start, end) {
  if (!dateOk(start) || !dateOk(end) || end < start) return null;
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1;
}
function chooseCurrentDurationContext(contexts, facts) {
  const oneD = contexts.get('OneD');
  if (oneD && dateOk(oneD.start) && dateOk(oneD.end) && !oneD.dimensional && facts.some(f => f.context_ref === 'OneD')) return oneD;
  const usable = [...contexts.values()].filter(c => c.start && c.end && !c.instant && !c.dimensional && dateOk(c.start) && dateOk(c.end));
  const withFacts = usable.map(c => ({ ...c, days: dateDurationDays(c.start, c.end), factCount: facts.filter(f => f.context_ref === c.id).length }))
    .filter(c => c.days && c.factCount);
  withFacts.sort((a, b) => a.days - b.days || b.end.localeCompare(a.end));
  return withFacts[0] || null;
}
function chooseInstantContext(contexts, facts, preferredId, periodEnd) {
  const preferred = contexts.get(preferredId);
  if (preferred && preferred.instant && preferred.end === periodEnd && !preferred.dimensional && facts.some(f => f.context_ref === preferredId)) return preferred;
  return [...contexts.values()].filter(c => c.instant && c.end === periodEnd && !c.dimensional && facts.some(f => f.context_ref === c.id))
    .sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')))[0] || null;
}
function pickFact(facts, contextId, aliases) {
  const wanted = new Set(aliases);
  return facts.find(f => f.context_ref === contextId && wanted.has(f.name)) || null;
}
function findSymbol(xml) {
  const re = /<([A-Za-z_][\w:.-]*)\b([^>]*\bcontextRef\s*=\s*[\"'][^\"']+[\"'][^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const m of String(xml).matchAll(re)) {
    if (!['NSESymbol', 'TradingSymbol', 'Symbol'].includes(localName(m[1]))) continue;
    const value = decodeXml(m[3].replace(/<[^>]+>/g, '').trim()).toUpperCase();
    if (value) return value;
  }
  return null;
}
export function parseNseXbrl(xmlText) {
  const xml = String(xmlText || '');
  if (!xml.trim() || xml.length > 5 * 1024 * 1024) throw new Error('XBRL document is empty or exceeds the 5 MB safety limit.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD and entity declarations are not accepted in NSE XBRL documents.');
  if (!/<(?:[\w.-]+:)?xbrl\b/i.test(xml) || !/<\/(?:[\w.-]+:)?xbrl\s*>/i.test(xml)) throw new Error('Response is not a complete XBRL instance document (xbrl root not found or not closed).');
  const contexts = parseContexts(xml), facts = parseFacts(xml);
  if (!contexts.size || !facts.length) throw new Error('XBRL structure changed: no usable contexts or numeric facts were found.');
  const context = chooseCurrentDurationContext(contexts, facts);
  if (!context) throw new Error('XBRL structure changed: no non-dimensional reporting-period context with numeric facts was found.');
  const figures = {}, elements = {};
  const addFact = (field, contextId) => {
    const fact = pickFact(facts, contextId, FACTS[field] || []);
    if (!fact) return;
    figures[field] = { value: fact.value, raw_value: fact.raw_value, unit: fact.unit_ref, decimals: fact.decimals, context_ref: fact.context_ref, element: fact.qualified_name };
    elements[field] = fact.qualified_name;
  };
  for (const field of ['revenue','interest_earned','total_income','profit_before_tax','net_profit','eps']) addFact(field, context.id);
  const balanceContext = chooseInstantContext(contexts, facts, 'OneI', context.end);
  if (balanceContext) for (const field of ['total_assets','total_equity']) addFact(field, balanceContext.id);
  const cashFlowContext = contexts.get('FourD');
  if (cashFlowContext && cashFlowContext.end === context.end && !cashFlowContext.dimensional && facts.some(f => f.context_ref === 'FourD')) addFact('operating_cash_flow', 'FourD');
  if (!Object.keys(figures).length) throw new Error('XBRL structure changed: none of the supported headline financial facts were present in the reporting-period contexts.');
  const symbol = findSymbol(xml);
  return {
    period: context.end.slice(0, 7),
    period_start: context.start,
    period_end: context.end,
    context_ref: context.id,
    symbol,
    figures,
    elements,
    facts_read: Object.keys(figures).length
  };
}
