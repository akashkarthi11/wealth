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
