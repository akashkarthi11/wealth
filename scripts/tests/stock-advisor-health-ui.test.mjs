import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
const route=readFileSync(new URL('../../api/_routes/stock-advisor.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../../style.css',import.meta.url),'utf8');

test('Stock Advisor API exposes provider configuration and verified evidence coverage',()=>{
 assert.match(route,/research_health/);
 assert.match(route,/verified_financials/);
 assert.match(route,/GROQ_ZERO_DATA_RETENTION_CONFIRMED/);
 assert.match(route,/FINCRUX_API_KEY/);
});

test('Stock Advisor overview displays provider health and collection freshness',()=>{
 assert.match(app,/Provider health & evidence/);
 assert.match(app,/Last data collection/);
 assert.match(app,/Verified financials/);
 assert.match(app,/Unverified financial snapshots and RSS listings cannot unlock a BUY decision/);
});

test('dashboard Run Now starts the full three-agent research schedule, not the old ticker-only pilot',()=>{
 assert.match(app,/Run full 3-agent research/);
 assert.match(app,/data-advisor-schedule-run-now/);
});

test('provider health UI has responsive status and evidence coverage styles',()=>{
 assert.match(css,/\.advisor-provider-grid/);
 assert.match(css,/\.advisor-coverage-grid/);
 assert.match(css,/\.status-needs_key/);
 assert.match(css,/\.advisor-collection-status/);
});

test('Provider Health can add, disable and remove encrypted Fincrux fallback keys',()=>{
 assert.match(app,/Fincrux API keys/);
 assert.match(app,/data-fincrux-key-save/);
 assert.match(app,/data-fincrux-key-toggle/);
 assert.match(app,/data-fincrux-key-delete/);
 assert.match(app,/Environment default/);
 assert.match(app,/Database override/);
 assert.match(css,/\.advisor-key-manager/);
});
