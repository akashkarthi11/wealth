import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
const route=readFileSync(new URL('../../api/_routes/stock-advisor.js',import.meta.url),'utf8');
const dir=readFileSync(new URL('../../api/_lib/provider-directory.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../../style.css',import.meta.url),'utf8');

test('Stock Advisor API exposes provider configuration and verified evidence coverage',()=>{
 assert.match(route,/research_health/);
 assert.match(route,/verified_financials/);
 // The provider list itself moved into provider-directory.js, shared with API usage, so neither page keeps its own
 // copy of this check (2026-11-24).
 assert.match(dir,/GROQ_ZERO_DATA_RETENTION_CONFIRMED/);
 assert.match(route,/buildProviderDirectory\(sql\)/);
 // Fincrux is configured by stored keys now, not by an environment variable, so the route reports the key metadata.
 assert.match(route,/listFincruxKeyMetadata/);
 assert.match(route,/fincrux_keys:fincruxKeys/);
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
 // A key from the environment and a key saved in the database must be told apart on screen.
 assert.match(app,/Environment key/);
 assert.match(app,/Saved key/);
 assert.match(css,/\.advisor-key-manager/);
});

test('each provider is its own expandable config panel, not one block shared by all of them', () => {
  // Clicking a provider's chip used to do nothing, and the Fincrux key manager (list + add button) was always shown
  // once, below the whole grid, regardless of which provider you clicked (owner's request 2026-11-24: "when i click
  // chips to show list of config list and add button").
  assert.match(app, /<details class="advisor-provider-card" data-provider-key="/, 'a native, accessible disclosure per provider');
  assert.match(app, /const providerConfigBody=p=>/);
  assert.match(app, /if\(p\.key==='fincrux'\)return fincruxKeyManager/, 'the key list and Add button live inside the Fincrux card itself');
  assert.doesNotMatch(app, /'<\/div>'\+fincruxKeyManager\+'<div class="advisor-coverage-grid">'/, 'no longer always shown below the whole grid');
  assert.match(css, /\.advisor-provider-card summary/, 'the chip/name row is the clickable summary');
  assert.match(css, /\.advisor-provider-card\[open\]/);
});

test('a provider panel the admin opened stays open across a reload, e.g. after saving a Fincrux key', () => {
  assert.match(app, /const providerHealthOpen=new Set\(\)/);
  assert.match(app, /providerHealthOpen\.has\(p\.key\)\?' open':''/, 'the open state is written back on render');
  assert.match(app, /addEventListener\('toggle',e=>\{const key=e\.target\?\.dataset\?\.providerKey/, 'and read back from the native toggle event');
});

test('every provider panel says whether a key can be set here, without ever showing one', () => {
  assert.match(app, /const providerUsageLine=p=>/);
  assert.match(app, /never shown here, cannot be set from this screen/);
  assert.match(app, /Open data; no key needed/);
  assert.doesNotMatch(app, /providerConfigBody[\s\S]{0,900}\.value\b/, 'the config panel never reads a decrypted key value');
});
