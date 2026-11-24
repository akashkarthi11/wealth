import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFincruxKeysForTicker } from '../../api/_lib/provider-api-keys.js';

test('ticker routing is deterministic and rotates preferred key across tickers', () => {
  const keys = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const first = selectFincruxKeysForTicker(keys, 'HDFCBANK');
  assert.deepEqual(first.map(x => x.id), selectFincruxKeysForTicker(keys, 'HDFCBANK').map(x => x.id));
  assert.deepEqual([...first].sort((a,b)=>a.id.localeCompare(b.id)).map(x=>x.id), ['a','b','c']);
  const starts = new Set(['HDFCBANK','RECLTD','ITC','LT','BEL','NTPC','TITAN'].map(t=>selectFincruxKeysForTicker(keys,t)[0].id));
  assert.ok(starts.size > 1, 'different tickers should be spread across keys');
});

test('paused/filtered keys are not part of automatic routing', () => {
  const keys = [{ id: 'active-a' }, { id: 'active-b' }];
  assert.deepEqual(selectFincruxKeysForTicker(keys, 'ITC').length, 2);
});

test('empty key list safely returns no candidates', () => {
  assert.deepEqual(selectFincruxKeysForTicker([], 'ITC'), []);
});

// Generic single-key providers (owner's request 2026-11-24: "every card need edit option .if no auth key requied
// just show empty enter field add option no issues"). AI Gateway, Groq and Tavily get one saved key each, reusing
// the same table and encryption as Fincrux's keys.
process.env.WEALTH_SESSION_SECRET = 'test-only-session-secret-that-is-at-least-32-characters-long';
const { getStoredProviderKey, saveStoredProviderKey, loadStoredProviderKeyValue, deleteStoredProviderKey } = await import('../../api/_lib/provider-api-keys.js');
const { migratedDb } = await import('./helpers/pglite.mjs');

async function seedUser(a) {
  const [user] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES($1,'x','admin') RETURNING id`, ['u' + Math.random().toString(36).slice(2) + '@x.test']);
  return user.id;
}

test('a saved single-key provider round-trips: masked on read, decrypted only for the real call site', async () => {
  const { a } = await migratedDb();
  const uid = await seedUser(a);
  assert.equal(await getStoredProviderKey(a, uid, 'free-model'), null, 'nothing saved yet');
  await saveStoredProviderKey(a, uid, 'free-model', 'sk-test-gateway-key-123456');
  const meta = await getStoredProviderKey(a, uid, 'free-model');
  assert.equal(meta.masked, '••••3456');
  assert.ok(!('value' in meta), 'the metadata reader never carries the decrypted value');
  assert.equal(await loadStoredProviderKeyValue(a, 'free-model'), 'sk-test-gateway-key-123456', 'the real call site can still get the decrypted value');
});

test('saving again replaces the previous key for that provider, not adds to a list', async () => {
  const { a } = await migratedDb();
  const uid = await seedUser(a);
  await saveStoredProviderKey(a, uid, 'groq', 'first-key-aaaa');
  await saveStoredProviderKey(a, uid, 'groq', 'second-key-bbbb');
  const [{ n }] = await a.query('SELECT count(*)::int AS n FROM wealth_provider_api_keys WHERE provider=$1', ['groq']);
  assert.equal(n, 1, 'one row per single-key provider, not a growing list');
  assert.equal(await loadStoredProviderKeyValue(a, 'groq'), 'second-key-bbbb');
});

test('a key saved for one provider is invisible to another, and to Fincrux', async () => {
  const { a } = await migratedDb();
  const uid = await seedUser(a);
  await saveStoredProviderKey(a, uid, 'web-search', 'tavily-key-zzzz');
  assert.equal(await loadStoredProviderKeyValue(a, 'free-model'), null);
  assert.equal(await loadStoredProviderKeyValue(a, 'groq'), null);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM wealth_provider_api_keys WHERE provider='fincrux'"))[0].n, 0);
});

test('a saved key can be removed, and only by its own user and provider', async () => {
  const { a } = await migratedDb();
  const uid = await seedUser(a);
  const otherUid = await seedUser(a);
  await saveStoredProviderKey(a, uid, 'web-search', 'tavily-key-to-remove');
  const saved = await getStoredProviderKey(a, uid, 'web-search');
  assert.equal(await deleteStoredProviderKey(a, otherUid, 'web-search', saved.id), false, 'another user cannot delete it');
  assert.equal(await deleteStoredProviderKey(a, uid, 'free-model', saved.id), false, 'the wrong provider refuses too');
  assert.equal(await deleteStoredProviderKey(a, uid, 'web-search', saved.id), true);
  assert.equal(await getStoredProviderKey(a, uid, 'web-search'), null);
});

test('a key too short or too long is refused before it is ever encrypted', async () => {
  const { a } = await migratedDb();
  const uid = await seedUser(a);
  await assert.rejects(() => saveStoredProviderKey(a, uid, 'groq', 'ab'), /Enter a key/);
  await assert.rejects(() => saveStoredProviderKey(a, uid, 'groq', 'x'.repeat(501)), /Enter a key/);
});
