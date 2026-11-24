import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptProviderKey, decryptProviderKey, loadFincruxApiKeys } from '../../api/_lib/provider-api-keys.js';
import { collectFincruxFinancials } from '../../api/_lib/stock-advisor-fincrux.js';

process.env.WEALTH_SESSION_SECRET = 'test-only-session-secret-that-is-at-least-32-characters-long';
const rowFor = (id, label, value, priority) => ({
  id, label, ...encryptProviderKey(value), key_fingerprint: 'fingerprint-' + id, priority, enabled: true
});

test('provider API keys are encrypted and can be decrypted only with the configured session secret', () => {
  const encrypted = encryptProviderKey('fincrux-secret-12345');
  assert.doesNotMatch(JSON.stringify(encrypted), /fincrux-secret-12345/);
  assert.equal(decryptProviderKey(encrypted), 'fincrux-secret-12345');
});

test('Fincrux key order is database overrides first, then environment defaults, without duplicates', async () => {
  process.env.FINCRUX_API_KEY = 'environment-secret-111';
  process.env.FINCRUX_API_KEY_2 = 'database-secret-222';
  const rows = [rowFor('db-1', 'Primary override', 'database-secret-222', 1), rowFor('db-2', 'Second override', 'database-secret-333', 2)];
  const db = { query: async sql => sql.includes('SELECT id FROM wealth_users')
    ? [{ id: 'owner-1' }] : sql.includes('SELECT id,label,encrypted_key')
      ? rows : [] };
  const keys = await loadFincruxApiKeys(db);
  assert.deepEqual(keys.map(k => k.value), ['database-secret-222', 'database-secret-333', 'environment-secret-111']);
  assert.equal(keys[0].source, 'database');
  assert.equal(keys[2].source, 'environment');
  delete process.env.FINCRUX_API_KEY;
  delete process.env.FINCRUX_API_KEY_2;
});

test('Fincrux falls through to the next key after the first key fails', async () => {
  const rows = [rowFor('db-bad', 'First key', 'bad-secret-111', 1), rowFor('db-good', 'Second key', 'good-secret-222', 2)];
  const calls = [], writes = [];
  const db = { query: async (sql, params=[]) => {
    if (sql.includes('SELECT id FROM wealth_users')) return [{ id: 'owner-1' }];
    if (sql.includes('SELECT id,label,encrypted_key')) return rows;
    if (sql.includes('SELECT retrieved_at FROM wealth_stock_advisor_research_sources')) return [];
    if (sql.includes('INSERT INTO wealth_stock_advisor_research_sources')) return [{ id: 'reservation-' + (writes.length + 1) }];
    if (sql.includes('UPDATE wealth_stock_advisor_research_sources')) { writes.push({ sql, params }); return []; }
    if (sql.includes('INSERT INTO wealth_api_audit')) return [];
    return [];
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const key = new URL(url).searchParams.get('api_key');
    calls.push(key);
    // The first key this ticker is routed to fails; the remaining one must still be tried.
    if (calls.length === 1) return new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });
    return new Response(JSON.stringify({
      success: true, trading_symbol: 'TEST', company: 'Test Limited',
      data: { quarterly_results: [{ quarter: 'Q2' }] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await collectFincruxFinancials({ instrument: { symbol: 'TEST' }, db });
    assert.equal(result.status, 'stored_unverified');
    assert.equal(result.attempted_keys, 2);
    assert.equal(result.request_limit_per_ist_day, 10);
    assert.equal(calls.length, 2, 'the second key is tried after the first fails');
    assert.notEqual(calls[0], calls[1], 'a different key, not the same one twice');
    assert.ok(['First key', 'Second key'].includes(result.key_label));
    assert.equal(writes.length, 2);
    assert.match(writes[0].sql, /verification_status='rejected'/);
    assert.match(writes[1].sql, /verification_status='unverified'/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
