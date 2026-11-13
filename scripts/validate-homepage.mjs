import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = readFileSync('index.html', 'utf8');
const js = readFileSync('app.js', 'utf8');

const syntax = spawnSync(process.execPath, ['--check', 'app.js'], { encoding: 'utf8' });
if (syntax.status !== 0) {
  process.stderr.write(syntax.stderr || 'app.js syntax validation failed\n');
  process.exit(1);
}

const ids = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]));
const refs = new Set([...js.matchAll(/[$][(]["']([^"']+)["'][)]/g)].map(m => m[1]));
const runtimeGeneratedIds = new Set(['fdMsg', 'rolesBox', 'pendingTx', 'offersBox', 'uploadBox', 'uploadFile', 'uploadPw', 'rmCount', 'activitySearch', 'activityKind', 'activityAccount', 'activityFrom', 'activityTo', 'activityCount', 'activityRows', 'activityFilterBadge', 'activityActiveFilters', 'activityClearAll', 'activityAdvancedFilters', 'activityFilterToggle', 'activitySummary', 'recordsList', 'recordsSearch', 'rewardsBox', 'lendingBox', 'splitOverlay']); // Elements created by app.js when their feature view is rendered.
const missing = [...refs].filter(id => !ids.has(id) && !runtimeGeneratedIds.has(id));
if (missing.length) {
  console.error('Homepage is missing HTML elements referenced by app.js:', missing.join(', '));
  process.exit(1);
}

const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1].split('?')[0]);
for (const src of scripts) {
  const file = src.startsWith('/') ? src.slice(1) : src;
  if (!existsSync(file)) {
    console.error('Homepage references a missing local script:', src);
    process.exit(1);
  }
}

for (const required of ['auth', 'app', 'loginTab', 'authForm', 'viewContent']) {
  if (!ids.has(required)) {
    console.error('Homepage is missing required element:', required);
    process.exit(1);
  }
}

mkdirSync('public', { recursive: true });
for (const file of ['index.html', 'app.js', 'style.css']) {
  copyFileSync(file, 'public/' + file);
}

console.log('Homepage validation passed and static assets copied to public/.');
