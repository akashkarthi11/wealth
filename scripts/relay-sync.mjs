// Runs inside Docker from scripts/relay-sync.sh. Makes the files on a GitHub branch identical to a local commit, through the
// karthi-github-relay: it reads the exact file list of the GitHub branch (path + git hash), compares it with the local list in
// /work/local.txt (git ls-tree -r output), and in "push" mode sends only what differs as ONE commit (added, changed, removed files).
// "plan" mode only prints the difference. Paths the relay refuses (secrets, build folders) are listed and left alone.
import { readFileSync } from 'node:fs';

const URL_ = process.env.RELAY_URL || 'https://app-dusky-kappa-29.vercel.app/api/relay';
const BRANCH = process.env.BRANCH, MODE = process.env.MODE || 'plan';
const secret = readFileSync('/sec/secret.txt', 'utf8').trim();
const BLOCKED = /(^|\/)(\.env[^/]*|\.git|\.vercel|node_modules|\.db-backups|public)(\/|$)|\.(pem|key|p12|pfx|jks)$/i;
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

const local = new Map();
for (const line of readFileSync('/work/local.txt', 'utf8').split('\n').filter(Boolean)) {
  const tab = line.indexOf('\t'), [, type, sha] = line.slice(0, tab).split(' ');
  if (type === 'blob') local.set(line.slice(tab + 1), sha);
}
const remote = await post({ action: 'tree', branch: BRANCH });
if (remote.truncated) { console.log('STOP: the GitHub file list is too long to compare.'); process.exit(2); }
const rmap = new Map(remote.files.map(f => [f.path, f.sha]));
const add = [], change = [], remove = [], skipped = [];
for (const [p, sha] of local) { if (BLOCKED.test(p)) continue; if (!rmap.has(p)) add.push(p); else if (rmap.get(p) !== sha) change.push(p); }
for (const p of rmap.keys()) { if (local.has(p)) continue; if (BLOCKED.test(p)) skipped.push(p); else remove.push(p); }
console.log('GitHub ' + BRANCH + ' is at ' + remote.sha.slice(0, 7) + ' with ' + remote.files.length + ' files; the local commit has ' + local.size + '.');
console.log('Differences: ' + add.length + ' to add, ' + change.length + ' to change, ' + remove.length + ' to remove' + (skipped.length ? ', ' + skipped.length + ' protected paths left alone' : '') + '.');
const show = (t, l) => { if (l.length) console.log(t + ':\n  ' + l.slice(0, 40).join('\n  ') + (l.length > 40 ? '\n  … and ' + (l.length - 40) + ' more' : '')); };
show('ADD', add); show('CHANGE', change); show('REMOVE', remove); show('PROTECTED (not touched)', skipped);
if (MODE !== 'push') process.exit(0);
if (!add.length && !change.length && !remove.length) { console.log('ALREADY_IDENTICAL'); process.exit(0); }
if (process.env.EXPECT && remote.sha !== process.env.EXPECT) { console.log('STOP: GitHub ' + BRANCH + ' moved while this ran. Run it again.'); process.exit(2); }
const tree = remove.map(path => ({ path, sha: null })), up = [...add, ...change];
for (let i = 0; i < up.length; i += 8) {
  const batch = up.slice(i, i + 8);
  const { blobs } = await post({ action: 'blobs', files: batch.map(p => ({ path: p, content: readFileSync('/repo/' + p).toString('base64') })) });
  for (const p of batch) tree.push({ path: p, sha: blobs[p] });
  console.log('blobs', Math.min(i + 8, up.length) + '/' + up.length);
  await new Promise(res => setTimeout(res, 2500));   // stay under GitHub's secondary rate limit
}
for (let i = 0; i < tree.length; i += 280) {
  const part = tree.slice(i, i + 280), r = await post({ action: 'commit', branch: BRANCH, message: process.env.MESSAGE + (tree.length > 280 ? ' (part ' + (i / 280 + 1) + ')' : ''), tree: part });
  console.log('COMMIT', r.commit, r.url);
}
