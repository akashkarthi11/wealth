// Runs inside Docker (node:20-alpine) from scripts/relay-push.sh. Sends the files listed in /work/changes.txt (git diff --name-status
// output) to GitHub through the karthi-github-relay Vercel project, as one commit on BRANCH. Never prints the secret.
import { readFileSync } from 'node:fs';

const URL_ = process.env.RELAY_URL || 'https://app-dusky-kappa-29.vercel.app/api/relay';
const BRANCH = process.env.BRANCH || 'claude-dev';
const secret = readFileSync('/sec/secret.txt', 'utf8').trim();
const message = readFileSync('/work/message.txt', 'utf8').trim();
const lines = readFileSync('/work/changes.txt', 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const dry = process.argv[2] === 'dry';

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

const tree = [], upload = [];
for (const [status, path] of lines) {
  if (status === 'D') tree.push({ path, sha: null });
  else upload.push(path);
}
console.log('branch', BRANCH, '| files to send:', upload.length, '| deletions:', tree.length);
if (dry) { console.log(upload.join('\n')); process.exit(0); }
for (let i = 0; i < upload.length; i += 8) {
  const batch = upload.slice(i, i + 8);
  const { blobs } = await post({ action: 'blobs', files: batch.map(p => ({ path: p, content: readFileSync('/repo/' + p).toString('base64') })) });
  for (const p of batch) tree.push({ path: p, sha: blobs[p] });
  console.log('blobs', Math.min(i + 8, upload.length) + '/' + upload.length);
}
const r = await post({ action: 'commit', branch: BRANCH, message, tree });
console.log('COMMIT', r.commit, r.url);
