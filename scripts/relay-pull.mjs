// Runs inside Docker from scripts/relay-pull.sh. Brings down what changed on GitHub since BASE (the last GitHub commit this
// laptop knows) through the karthi-github-relay: writes the changed files to /out/files, a list of deleted files to /out/deleted.txt
// and /out/meta.json. Read only. Never prints the secret.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const URL_ = process.env.RELAY_URL || 'https://app-dusky-kappa-29.vercel.app/api/relay';
const BRANCH = process.env.BRANCH, BASE = process.env.BASE;
const secret = readFileSync('/sec/secret.txt', 'utf8').trim();
const post = async (body, tries = 3) => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error('relay ' + r.status + ': ' + (d.error || '')), { final: r.status < 500 });
      return d;
    } catch (e) { if (e.final || i >= tries) throw e; await new Promise(res => setTimeout(res, 1500 * i)); }
  }
};

const head = await post({ action: 'status', branch: BRANCH });
console.log('GitHub ' + BRANCH + ' is at ' + head.sha.slice(0, 7) + ' — ' + head.message + ' (' + head.date + ')');
if (head.sha === BASE) { console.log('UP_TO_DATE'); process.exit(0); }
const cmp = await post({ action: 'compare', base: BASE, head: head.sha });
console.log('status:', cmp.status, '| GitHub is ahead by', cmp.aheadBy, '| behind by', cmp.behindBy);
for (const c of cmp.commits) console.log('  commit:', c);
if (cmp.truncated) console.log('WARNING: more than 300 files changed; only the first 300 are listed.');
if (cmp.blocked.length) console.log('Not pulled (secret or build paths):', cmp.blocked.join(', '));
const del = cmp.files.filter(f => f.status === 'removed').map(f => f.path);
const get = cmp.files.filter(f => f.status !== 'removed');
for (let i = 0; i < get.length; i += 10) {
  const { files } = await post({ action: 'get', files: get.slice(i, i + 10).map(f => ({ path: f.path, sha: f.sha })) });
  for (const f of files) { mkdirSync(dirname('/out/files/' + f.path), { recursive: true }); writeFileSync('/out/files/' + f.path, Buffer.from(f.content, 'base64')); }
  console.log('files', Math.min(i + 10, get.length) + '/' + get.length);
}
writeFileSync('/out/deleted.txt', del.join('\n'));
writeFileSync('/out/meta.json', JSON.stringify({ sha: head.sha, message: head.message, files: get.length, deleted: del.length }));
console.log('PULLED', get.length, 'files,', del.length, 'deleted');
