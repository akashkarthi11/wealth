/**
 * Evidence contract for Stock Advisor research.
 * Provider adapters must return normalized source records; agents must never receive
 * unlabelled figures as if they were verified facts.
 */
const ALLOWED_SOURCE_TYPES = new Set(['exchange_filing','company_filing','financial_statement','market_price','technical_indicator','news','broker_research','web','fund_nav','fund_profile','portfolio_composition','benchmark_data','corporate_announcement']);
const MAX_SOURCE_AGE_HOURS = Object.freeze({ market_price: 36, technical_indicator: 36, news: 24 * 14, web: 24 * 45 });

export function normalizeResearchSource(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Research source must be an object.');
  const url = String(input.url || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Research source URL must be absolute.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Research source URL must use HTTP or HTTPS.');
  const title = String(input.title || '').trim();
  if (!title || title.length > 500) throw new TypeError('Research source title is required (max 500 characters).');
  const sourceType = ALLOWED_SOURCE_TYPES.has(input.source_type) ? input.source_type : 'web';
  const publishedAt = input.published_at ? Date.parse(input.published_at) : null;
  if (input.published_at && !Number.isFinite(publishedAt)) throw new TypeError('Research source published_at must be a valid date.');
  const retrievedAt = input.retrieved_at ? Date.parse(input.retrieved_at) : now;
  if (!Number.isFinite(retrievedAt) || retrievedAt > now + 5 * 60 * 1000) throw new TypeError('Research source retrieved_at is invalid or in the future.');
  const ageHours = (now - retrievedAt) / 3_600_000;
  const maxAge = MAX_SOURCE_AGE_HOURS[sourceType];
  const requestedStatus = String(input.verification_status || 'unverified');
  const verificationStatus = requestedStatus === 'verified' && (!maxAge || ageHours <= maxAge) ? 'verified'
    : requestedStatus === 'rejected' ? 'rejected'
    : maxAge && ageHours > maxAge ? 'stale' : 'unverified';
  return {
    ticker: String(input.ticker || '').trim().toUpperCase(),
    source_type: sourceType,
    title,
    url: parsed.toString(),
    publisher: String(input.publisher || '').trim().slice(0, 200) || null,
    published_at: publishedAt == null ? null : new Date(publishedAt).toISOString(),
    retrieved_at: new Date(retrievedAt).toISOString(),
    excerpt: String(input.excerpt || '').trim().slice(0, 5000) || null,
    evidence: input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence) ? input.evidence : {},
    verification_status: verificationStatus
  };
}

export function buildEvidenceContext(sources, now = Date.now()) {
  const normalized = (Array.isArray(sources) ? sources : []).map(source => normalizeResearchSource(source, now));
  const verified = normalized.filter(source => source.verification_status === 'verified');
  const stale = normalized.filter(source => source.verification_status === 'stale');
  const missingTypes = ['market_price', 'financial_statement', 'technical_indicator']
    .filter(type => !verified.some(source => source.source_type === type || (type === 'market_price' && source.source_type === 'fund_nav')));
  return {
    sources: normalized,
    verified_source_count: verified.length,
    stale_source_count: stale.length,
    missing_evidence_types: missingTypes,
    action_gate: missingTypes.length ? 'DATA_REQUIRED' : 'EVIDENCE_READY'
  };
}

export const STOCK_ADVISOR_STAGES = Object.freeze([
  'collect_evidence', 'fundamental_analysis', 'technical_analysis',
  'bull_case', 'bear_case', 'bull_rebuttal', 'bear_rebuttal',
  'evidence_validation', 'cio_decision', 'independent_review', 'persist_report'
]);
