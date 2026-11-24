// Grouped menu (2026-11-11): every view is reachable, in the owner's chosen order, and labelled by group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const nav = html.match(/<nav id="menuNav"[\s\S]*?<\/nav>/)[0];
const mobile = html.match(/<nav id="mobileNav"[\s\S]*?<\/nav>/)[0];
const viewsIn = s => [...s.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]);

test('desktop menu: Money · Activity · Tools, in that order', () => {
  const groups = [...nav.matchAll(/<div class="nav-group" aria-label="([^"]+)">([\s\S]*?)<\/div>/g)].map(m => [m[1], viewsIn(m[2])]);
  assert.deepEqual(groups, [
    ['Money', ['overview', 'banks', 'investments', 'interest', 'rewards', 'lending', 'offers']],
    ['Activity', ['transactions', 'alerts', 'subscriptions', 'upload']],
  ]);
  const tools = viewsIn(nav.match(/id="toolsMenu"[\s\S]*$/)[0]);
  assert.deepEqual(tools, ['stock-advisor', 'angel-one', 'other', 'data-quality', 'settings', 'jobs', 'ai-data', 'api-usage', 'provider-health']);
  assert.match(nav, /data-view="ai-data"[^>]*data-owner-only/, 'AI data is owner-only');
  assert.match(nav, /data-view="data-quality"[^>]*data-owner-only/, 'data quality is owner-only');
  assert.match(nav, /data-view="jobs"[^>]*data-owner-only/, 'scheduled jobs are owner-only');
});

test('every view in app.js is reachable from the desktop menu and has a group label', () => {
  const views = JSON.parse(app.match(/const views=(\[\[[\s\S]*?\]\]);/)[1].replace(/'/g, '"')).map(v => v[0]);
  const reachable = new Set(viewsIn(nav));
  for (const v of views.filter(v => v !== 'more')) assert.ok(reachable.has(v), `menu is missing ${v}`);
  for (const v of views) assert.match(app, new RegExp(`["']?${v}["']?:"[A-Z ]+"`), `no group label for ${v}`);
});

test('mobile tab bar: Home, Banks, Invest, Activity, More; alert badge on More', () => {
  assert.deepEqual(viewsIn(mobile), ['overview', 'banks', 'investments', 'transactions', 'more']);
  assert.match(mobile, /id="mobileMore"[^>]*>[\s\S]*data-alert-badge/);
  assert.match(nav, /data-view="alerts"[\s\S]*?data-alert-badge/);
});

test('no menu is listed twice, in the More hub or anywhere else', () => {
  // The provider-key merge left Provider Health in the More hub twice, with two icons and two descriptions, and left a
  // second "provider-health" key in VIEW_GROUPS. Both read as one duplicated row to anyone using the app (2026-11-24).
  const hub = app.match(/function moreHubHtml\(\)\{[\s\S]*?\n\}/)[0];
  const twice = [];
  for (const group of hub.matchAll(/\{group:'([^']+)',items:\[([\s\S]*?)\]\}/g)) {
    const keys = [...group[2].matchAll(/\['([a-z-]+)',/g)].map(m => m[1]);
    for (const k of keys) if (keys.indexOf(k) !== keys.lastIndexOf(k)) twice.push(group[1] + ' › ' + k);
  }
  assert.deepEqual([...new Set(twice)], [], 'listed twice in the More hub');

  const groupKeys = [...app.match(/const VIEW_GROUPS=\{([\s\S]*?)\};/)[1].matchAll(/"?([a-z-]+)"?:"/g)].map(m => m[1]);
  const repeated = groupKeys.filter(k => groupKeys.indexOf(k) !== groupKeys.lastIndexOf(k));
  assert.deepEqual([...new Set(repeated)], [], 'repeated key in VIEW_GROUPS');

  // Every owner-only tool reaches its page from both places, exactly once each.
  const tools = viewsIn(nav.match(/id="toolsMenu"[\s\S]*$/)[0]);
  for (const v of ['ai-data', 'api-usage', 'provider-health']) {
    assert.equal(tools.filter(t => t === v).length, 1, v + ' appears once in the Tools menu');
    assert.equal(hub.split("['" + v + "',").length - 1, 1, v + ' appears once in the More hub');
  }
});
