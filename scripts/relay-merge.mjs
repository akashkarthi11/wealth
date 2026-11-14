// Runs inside Docker from scripts/relay-merge.sh. Merges HEAD_BRANCH into BASE_BRANCH on GitHub through the karthi-github-relay.
import { readFileSync } from 'node:fs';

const URL_ = process.env.RELAY_URL || 'https://app-dusky-kappa-29.vercel.app/api/relay';
const secret = readFileSync('/sec/secret.txt', 'utf8').trim();
const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
  body: JSON.stringify({ action: 'merge', base: process.env.BASE_BRANCH, head: process.env.HEAD_BRANCH, message: process.env.MESSAGE || undefined }) });
const d = await r.json().catch(() => ({}));
if (!r.ok) { console.log('FAILED ' + r.status + ': ' + (d.error || '')); process.exit(1); }
console.log(d.merged ? 'MERGED ' + d.sha + ' ' + d.url : 'ALREADY_UP_TO_DATE: ' + process.env.BASE_BRANCH + ' already contains ' + process.env.HEAD_BRANCH);
