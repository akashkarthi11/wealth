// Owner 2026-11-11 "set v2 default": the dashboard shows the account model (v2) by default; WEALTH_DASHBOARD_MODEL=v1
// reverts it; WEALTH_DATA_MODEL=v2 always means v2; dataModel() (where new records are written) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardModel, dataModel } from '../../api/_lib.js';

test('dashboard defaults to v2, can be reverted with WEALTH_DASHBOARD_MODEL=v1', () => {
  assert.equal(dashboardModel({}), 'v2');
  assert.equal(dashboardModel({ WEALTH_DASHBOARD_MODEL: 'v1' }), 'v1');
  assert.equal(dashboardModel({ WEALTH_DASHBOARD_MODEL: ' V1 ' }), 'v1');
  assert.equal(dashboardModel({ WEALTH_DASHBOARD_MODEL: 'v1', WEALTH_DATA_MODEL: 'v2' }), 'v2', 'full v2 data model wins');
  assert.equal(dashboardModel({ WEALTH_DASHBOARD_MODEL: 'anything' }), 'v2');
});

test('write model is unchanged (still v1 unless WEALTH_DATA_MODEL=v2)', () => {
  const before = process.env.WEALTH_DATA_MODEL; delete process.env.WEALTH_DATA_MODEL;
  try { assert.equal(dataModel(), 'v1'); } finally { if (before !== undefined) process.env.WEALTH_DATA_MODEL = before; }
});

test('dashboard route: owner ?model=v1 compares, ?model=v2 forces, otherwise the default', () => {
  const src = readFileSync(new URL('../../api/_routes/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /const wantV2=admin&&asked==='v1'\?false:admin&&asked==='v2'\?true:defaultV2;/, 'only the owner can switch per request');
  assert.match(src, /variant:\[asked\|\|'default',dashboardModel\(\),day\]\.join\(':'\)/, 'cache key per model choice and IST day');
  const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  assert.match(app, /'\/api\/dashboard'\+\(wantModelV1\(\)\?'\?model=v1':''\)/);
  assert.match(app, /Compare with old dashboard \(v1\)/);
});
