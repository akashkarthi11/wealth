import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEvidenceContext, normalizeResearchSource } from '../../api/_lib/stock-advisor-evidence.js';

const now = Date.parse('2026-11-22T12:00:00Z');
test('rejects relative and non-http evidence URLs', () => {
  assert.throws(() => normalizeResearchSource({ title: 'x', url: '/relative' }, now));
  assert.throws(() => normalizeResearchSource({ title: 'x', url: 'javascript:alert(1)' }, now));
});
test('downgrades stale market data even if a provider marks it verified', () => {
  const source = normalizeResearchSource({ title: 'Quote', url: 'https://example.com/quote', source_type: 'market_price', retrieved_at: '2026-11-20T00:00:00Z', verification_status: 'verified' }, now);
  assert.equal(source.verification_status, 'stale');
});
test('holds when key evidence types are missing', () => {
  const result = buildEvidenceContext([{ title: 'News', url: 'https://example.com/news', source_type: 'news', verification_status: 'verified' }], now);
  assert.equal(result.action_gate, 'DATA_REQUIRED');
  assert.deepEqual(result.missing_evidence_types, ['market_price', 'financial_statement', 'technical_indicator']);
});
test('allows evidence-ready only when price, statements and technical data are all fresh', () => {
  const types = ['market_price', 'financial_statement', 'technical_indicator'];
  const sources = types.map(type => ({ title: type, url: 'https://example.com/' + type, source_type: type, verification_status: 'verified', retrieved_at: new Date(now).toISOString() }));
  assert.equal(buildEvidenceContext(sources, now).action_gate, 'EVIDENCE_READY');
});

const advisorRoute = readFileSync(new URL('../../api/_routes/stock-advisor.js', import.meta.url), 'utf8');

test('Nemotron Gateway requests disable hidden reasoning for concise JSON answers', () => {
  assert.match(advisorRoute, /reasoning:\s*\{\s*effort:\s*'none'\s*\}/);
  assert.match(advisorRoute, /response_format:\s*\{\s*type:\s*'json_object'\s*\}/);
  assert.match(advisorRoute, /max_tokens:\s*4096/);
});

test('empty Gateway responses include finish reason and token diagnostics', () => {
  assert.match(advisorRoute, /finish_reason/);
  assert.match(advisorRoute, /completion_tokens/);
  assert.match(advisorRoute, /no final content/);
});
