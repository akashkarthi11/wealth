// Owner recovery: set a new password for an account directly in the database.
// Use only when no admin can sign in. Revokes every existing session for that account.
//
//   node scripts/admin/reset-password.mjs <env-file> <email> --yes
//   (the new password is read from the NEW_PASSWORD environment variable or from stdin)
import { readFileSync } from 'node:fs';

const [envFile, email, confirm] = process.argv.slice(2);
if (!envFile || !email || confirm !== '--yes') {
  console.error('usage: NEW_PASSWORD=... node scripts/admin/reset-password.mjs <env-file> <email> --yes');
  process.exit(2);
}
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
let password = process.env.NEW_PASSWORD;
if (!password) { let s = ''; for await (const c of process.stdin) s += c; password = s.replace(/\r?\n$/, ''); }

const { sql, hash, passwordProblem } = await import('../../api/_lib.js');
const problem = passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }
if (!sql) { console.error('No database URL in ' + envFile); process.exit(1); }

const rows = await sql.query(
  'UPDATE wealth_users SET password_hash=$1, session_version=session_version+1 WHERE email=$2 RETURNING email, session_version',
  [hash(password), email.trim().toLowerCase()]
);
if (!rows.length) { console.error('No account found for ' + email); process.exit(1); }
console.log('Password reset for', rows[0].email, '- sessions revoked (version', rows[0].session_version + ')');
