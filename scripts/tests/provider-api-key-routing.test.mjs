import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFincruxKeysForTicker } from '../../api/_lib/provider-api-keys.js';

test('explicit ticker assignment selects only matching Fincrux keys', () => {
  const keys = [
    { id: 'a', assigned_tickers: ['HDFCBANK'] },
    { id: 'b', assigned_tickers: ['RECLTD'] },
    { id: 'c', assigned_tickers: [] }
  ];
  assert.deepEqual(selectFincruxKeysForTicker(keys, 'recltd').map(x => x.id), ['b']);
  assert.deepEqual(selectFincruxKeysForTicker(keys, 'HDFCBANK').map(x => x.id), ['a']);
});

test('unassigned keys remain the fallback when no explicit ticker assignment matches', () => {
  const keys = [
    { id: 'a', assigned_tickers: ['HDFCBANK'] },
    { id: 'b', assigned_tickers: [] }
  ];
  assert.deepEqual(selectFincruxKeysForTicker(keys, 'RECLTD').map(x => x.id), ['b']);
});

test('all-key routing remains backward compatible when no keys have assignments', () => {
  const keys = [{ id: 'a' }, { id: 'b', assigned_tickers: [] }];
  assert.deepEqual(selectFincruxKeysForTicker(keys, 'ITC').map(x => x.id), ['a', 'b']);
});

test('ticker with no matching assignment and no fallback key is skipped', () => {
  assert.deepEqual(selectFincruxKeysForTicker([{ id: 'a', assigned_tickers: ['HDFCBANK'] }], 'RECLTD'), []);
});
