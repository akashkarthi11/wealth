// Portable test runner: finds every *.test.mjs under scripts/ and runs them with node --test.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.mjs')) files.push(p);
  }
})(root);
const r = spawnSync(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit' });
process.exit(r.status ?? 1);
