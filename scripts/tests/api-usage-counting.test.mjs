// Usage must mean "requests the provider actually answered". A step that was skipped or deferred sent nothing and used
// no allowance, so counting planned steps overstated usage (owner's rule, 2026-11-24). wealth_api_audit holds one row
// per real request, split by whether the provider answered or errored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SRC = read('api/_routes/api-usage.js');
// The provider list and its queries moved into provider-directory.js, shared with Provider Health (2026-11-24).
const DIR = read('api/_lib/provider-directory.js');
const IST_DAY = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";

const record = (a, provider, ok, when = 'now()') => a.query(`INSERT INTO wealth_api_audit (provider,endpoint,ticker,ok,duration_ms,created_at)
  VALUES ($1,'https://x.test/a','T',$2,10,${when})`, [provider, ok]);

test('a request counts once the provider answers, whether it succeeded or errored', async () => {
  const { a } = await migratedDb();
  await record(a, 'TejHQ NSE EOD', true);
  await record(a, 'TejHQ NSE EOD', true);
  await record(a, 'TejHQ NSE EOD', false);          // an error IS a used request
  await record(a, 'Fincrux', false);
  await record(a, 'TejHQ NSE EOD', true, IST_DAY + " - interval '2 hours'");   // yesterday IST

  const rows = await a.query(`SELECT provider,
      count(*) FILTER (WHERE ok)::int AS succeeded,
      count(*) FILTER (WHERE NOT ok)::int AS failed,
      count(*)::int AS requests
    FROM wealth_api_audit WHERE created_at >= ${IST_DAY} GROUP BY 1 ORDER BY 1`);
  const byProvider = new Map(rows.map(r => [r.provider, r]));
  assert.deepEqual([byProvider.get('TejHQ NSE EOD').requests, byProvider.get('TejHQ NSE EOD').succeeded, byProvider.get('TejHQ NSE EOD').failed], [3, 2, 1],
    'three answered today; the one from before midnight IST is not today');
  assert.deepEqual([byProvider.get('Fincrux').requests, byProvider.get('Fincrux').failed], [1, 1],
    'a failed request still consumed the allowance');
});

test('the route reads usage from the audit, not from planned steps', () => {
  assert.match(DIR, /FROM wealth_api_audit WHERE created_at >= \$\{IST_DAY\} GROUP BY 1/, 'counted per provider for the Indian day');
  assert.match(DIR, /count\(\*\) FILTER \(WHERE ok\)::int AS succeeded/);
  assert.match(DIR, /count\(\*\) FILTER \(WHERE NOT ok\)::int AS failed/);
  // every provider's "used" comes from answered requests
  for (const label of ['TejHQ NSE EOD', 'MFAPI.in', 'NSE RSS', 'Yahoo Finance fundamentals', 'Open currency API']) {
    assert.ok(DIR.includes(`answeredByProvider.get('${label}')`), label + ' takes its usage from the audit');
  }
  assert.doesNotMatch(DIR, /used: num\(\(byProvider\.get\(/, 'no provider still counts planned steps as usage');
});

test('work that never reached the provider is reported apart from usage, never added to it', () => {
  assert.match(DIR, /skipped: num\(s\.skipped\)/, 'skipped still comes from the planned steps');
  assert.match(DIR.replace(/\s+/g, ' '), /deferred step is not a request: it sent nothing and used no allowance/, 'and the reason is written down');
  const app = read('app.js');
  assert.match(app, /request'\+\(p\.requests===1\?'':'s'\)\+' answered today/);
  assert.match(app, /p\.skipped\+' not sent'/, 'shown as not sent, not as usage');
  assert.doesNotMatch(app, /p\.calls\+' calls today'/, 'the old step-based count is gone');
});

test('the providers we actually call all appear on the page', () => {
  for (const key of ['fincrux', 'free-model', 'tejhq', 'mfapi', 'nse', 'yahoo', 'fx', 'groq']) {
    assert.ok(DIR.includes(`key: '${key}'`), key + ' is listed');
  }
});
