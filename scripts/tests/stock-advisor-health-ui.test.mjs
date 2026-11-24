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

test('every non-Fincrux card has its own single-key editor, even one with no key at all', () => {
  // Owner's request 2026-11-24: "every card need edit option .if no auth key requied just show empty enter field add
  // option no issues" - every card gets the same add/replace/remove control, uniformly, rather than a read-only line
  // on the providers that used to say the key could not be set from the app.
  assert.match(app, /const providerUsageLine=p=>/);
  assert.match(app, /const providerKeyEditor=p=>/);
  assert.match(app, /data-provider-key-save="'\+esc\(p\.key\)/, 'every card gets a save control');
  assert.match(app, /No key needed for this provider — save one anyway if you want/, 'a keyless provider still gets the field, not a special case');
  assert.doesNotMatch(app, /providerKeyEditor[\s\S]{0,900}\.value\b/, 'the editor never reads a decrypted key value, only .masked');
  assert.match(app, /saved\.masked\|\|'Unavailable'/, 'only the masked form is ever shown');

  const providersRoute=readFileSync(new URL('../../api/_routes/providers.js',import.meta.url),'utf8');
  assert.match(providersRoute, /action === 'provider_key_save'/);
  assert.match(providersRoute, /action === 'provider_key_delete'/);
  assert.doesNotMatch(providersRoute, /provider_key_save[\s\S]{0,400}\.value\b/, 'the save response never echoes the key back');
  const providerApiKeysLib=readFileSync(new URL('../../api/_lib/provider-api-keys.js',import.meta.url),'utf8');
  assert.match(providerApiKeysLib, /export async function saveStoredProviderKey/);
  assert.match(providerApiKeysLib, /export async function getStoredProviderKey/);
  assert.doesNotMatch(providerApiKeysLib.slice(providerApiKeysLib.indexOf('getStoredProviderKey')), /\.value\b/, 'the metadata reader never returns the decrypted value');
});

test('a saved single-key provider is checked by the real call sites, not only displayed', () => {
  // A control that saves a key but that nothing reads would be exactly the kind of dead, misleading UI the project
  // rules warn against - so every one of these three has to actually be checked at its real call site.
  const debate=readFileSync(new URL('../../api/_lib/stock-advisor-debate.js',import.meta.url),'utf8');
  assert.match(debate, /loadStoredProviderKeyValue\(sql,'free-model'\)/, 'the AI Gateway key is checked before the env var');
  assert.match(debate, /loadStoredProviderKeyValue\(sql,'groq'\)/, 'the Groq key is checked before the env var');
  const search=readFileSync(new URL('../../api/_lib/agent-search.js',import.meta.url),'utf8');
  assert.match(search, /loadStoredProviderKeyValue\(db, 'web-search'\)/, 'the Tavily key is checked before the env var');
  // Fincrux is excluded from the generic save path: it already has its own multi-key, ticker-sharded storage, which
  // a "one row replaces all" save would corrupt.
  const providersRoute=readFileSync(new URL('../../api/_routes/providers.js',import.meta.url),'utf8');
  assert.match(providersRoute, /key !== 'fincrux'/);
});

test('provider cards are one column on a phone, not squeezed two or three to a row', () => {
  // A 2- or 3-column grid gave each card ~110-160px on a phone, so the name, detail, status chip and the new expand
  // chevron were cramped into it - the chip wrapped or the name truncated (owner's report 2026-11-24: "look the view
  // in mobile, worst solve it").
  const base = css.slice(css.indexOf('.advisor-provider-grid{'), css.indexOf('.advisor-provider-grid{', css.indexOf('.advisor-provider-grid{') + 1));
  assert.match(base, /grid-template-columns:1fr/, 'one column by default (mobile-first)');
  assert.match(css, /@media\(min-width:480px\)\{\.advisor-provider-grid\{grid-template-columns:repeat\(2,/, 'two only from a small-tablet width up');
  assert.match(css, /\.advisor-provider-status\{[^}]*flex:0 0 auto[^}]*white-space:nowrap/, 'the chip can never wrap or get crushed to nothing');
  assert.match(css, /\.advisor-provider-card summary>div\{[^}]*flex:1 1 auto/, 'the name/detail column takes the remaining space, not a fixed share');
});
