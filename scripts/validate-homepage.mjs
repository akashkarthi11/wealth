import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = readFileSync('index.html', 'utf8');
const js = readFileSync('app.js', 'utf8');

const syntax = spawnSync(process.execPath, ['--check', 'app.js'], { encoding: 'utf8' });
if (syntax.status !== 0) {
  process.stderr.write(syntax.stderr || 'app.js syntax validation failed\n');
  process.exit(1);
}

const ids = new Set([...html.matchAll(/\\bid=["']([^"']+)["']/g)].map(m => m[1]));
const refs = new Set([...js.matchAll(/\\$\\(["']([^"']+)["']\\)/g)].map(m => m[1]));
const missing = [...refs].filter(id => !ids.has(id));
if (missing.length) {
  console.error('Homepage is missing HTML elements referenced by app.js:', missing.join(', '));
  process.exit(1);
}

const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1].split('?')[0]);
for (const src of scripts) {
  const file = src.replace(/^\\//, '');
  if (!existsSync(file)) {
    console.error('Homepage references a missing local script:', src);
    process.exit(1);
  }
}

for (const required of ['auth', 'app', 'logout', 'loginTab', 'authForm', 'viewContent']) {
  if (!ids.has(required)) {
    console.error('Homepage is missing required element:', required);
    process.exit(1);
  }
}

console.log('Homepage validation passed: JavaScript syntax, referenced HTML IDs, and local scripts.');
