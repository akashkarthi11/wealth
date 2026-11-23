import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const debate = readFileSync(new URL('../../api/_lib/stock-advisor-debate.js', import.meta.url), 'utf8');
const collection = readFileSync(new URL('../../api/_lib/stock-advisor-data-collection.js', import.meta.url), 'utf8');
const liveEvidence = readFileSync(new URL('../../api/_lib/stock-advisor-live-evidence.js', import.meta.url), 'utf8');

test('Groq fallback requires an explicit Zero Data Retention confirmation', () => {
  assert.match(debate, /GROQ_ZERO_DATA_RETENTION_CONFIRMED/);
  assert.match(debate, /if\(!key\|\|!zeroRetention\)return null/);
});

test('Groq fallback is pinned to a free-plan model and preserves provider metadata', () => {
  assert.match(debate, /openai\/gpt-oss-20b/);
  assert.match(debate, /provider:'Groq'/);
  assert.match(debate, /model:model\.model,provider:model\.provider/);
});

test('unverified financial data cannot be represented as verified facts in agent prompts', () => {
  assert.match(debate, /UNVERIFIED THIRD-PARTY DATA/);
  assert.match(debate, /must never be presented as verified facts/);
});

test('scheduled collection reuses canonical TejHQ, MFAPI and NSE adapters', () => {
  assert.match(collection, /collectMutualFundEvidence/);
  assert.match(collection, /collectTejHqEquityEvidence/);
  assert.match(collection, /collectNseNewsBatch/);
  assert.doesNotMatch(collection, /function collectTejHQEquity/);
  assert.doesNotMatch(collection, /function collectEquityNews/);
});

test('NSE batch collector stores exchange-feed listings as unverified until filing content is validated', () => {
  assert.match(liveEvidence, /official_exchange_feed:true/);
  assert.match(liveEvidence, /content_kind:'rss_listing_only'/);
  assert.match(liveEvidence, /'unverified'/);
});
