// Share a person's lending summary by link, and their "I've paid" requests (migration 0023).
// The link carries a random secret; only its SHA-256 is stored, so a new link replaces the old one. The public page shows
// that one person's entries only — no account names, no transaction descriptions, nothing about anyone else.
// Accepting a request (owner): the money is recorded as a received transfer on the chosen account + a "paid back" entry;
// optionally added to that account's balance (owner-confirmed estimate, status 'reported' / 'stale'); optionally the lend
// is closed (status settled). Everything in one database transaction; nothing is deleted.
import { createHash, randomBytes } from 'node:crypto';
import { sql, withActor, httpError, isUuid, isDay } from './_lib.js';
import { loansOverview } from './_loans.js';

const r2 = x => Math.round(x * 100) / 100;
const text = (v, max = 300) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) || null);
const istToday = now => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const hashToken = t => createHash('sha256').update(String(t)).digest('base64url');
export const validToken = t => /^[A-Za-z0-9_-]{32,64}$/.test(String(t || ''));

async function ownPerson(db, uid, personId) {
  if (!isUuid(personId)) throw httpError(400, 'personId must be a person id');
  const [p] = await db.query(`SELECT id, name FROM wealth_people WHERE id = $1 AND user_id = $2 AND status <> 'removed'`, [personId, uid]);
  if (!p) throw httpError(404, 'Person not found');
  return p;
}

// POST /api/loans/share {personId, action: 'create' | 'revoke'} — create returns the link path once (/l/<secret>).
export async function shareLink(uid, b, { db = sql, actor = 'owner', dryRun = false } = {}) {
  const p = await ownPerson(db, uid, b?.personId);
  const action = String(b?.action || 'create');
  if (!['create', 'revoke'].includes(action)) throw httpError(400, 'action must be create or revoke');
  if (dryRun) return { dryRun, personId: p.id, action };
  if (action === 'revoke') {
    await withActor(db, actor, [[`UPDATE wealth_people SET share_token_hash = NULL, share_created_at = NULL, updated_at = now() WHERE id = $1`, [p.id]]]);
    return { stored: true, personId: p.id, shared: false };
  }
  const token = randomBytes(24).toString('base64url');           // 32 characters, 192 bits
  await withActor(db, actor, [[`UPDATE wealth_people SET share_token_hash = $2, share_created_at = now(), updated_at = now() WHERE id = $1`, [p.id, hashToken(token)]]]);
  return { stored: true, personId: p.id, shared: true, path: '/l/' + token };
}

async function personByToken(db, token) {
  if (!validToken(token)) return null;
  const [p] = await db.query(`SELECT id, user_id, name FROM wealth_people WHERE share_token_hash = $1 AND status <> 'removed'`, [hashToken(token)]);
  return p || null;
}

// What the person sees: their own entries only.
export async function publicLendView(token, { db = sql, now = Date.now() } = {}) {
  const p = await personByToken(db, token);
  if (!p) return null;
  const o = await loansOverview(p.user_id, { db, now });
  const me = o.people.find(x => x.id === p.id);
  if (!me) return null;
  const reqs = await db.query(`SELECT amount::float8 AS amount, paid_on::text AS paid_on, method, status, created_at, accepted_amount::float8 AS accepted_amount
    FROM wealth_lend_requests WHERE person_id = $1 ORDER BY created_at DESC LIMIT 10`, [p.id]);
  return { name: me.name, owed: me.owed, lent: me.lent, repaid: me.repaid, status: me.status, asOf: o.asOf,
    items: me.items.map(i => ({ entryId: i.entryId || null, shareId: i.shareId || null, on: i.on, label: i.label, amount: i.amount, direction: i.direction, writtenOff: !!i.writtenOff,
      detail: i.type === 'bill' ? i.detail : null, note: i.note || null, comments: (i.comments || []).map(c => ({ author: c.author, body: c.body, at: c.at })),
      paid: i.type === 'bill' ? !!i.paid : undefined })),
    requests: reqs.map(r => ({ amount: r.amount, paidOn: r.paid_on, method: r.method, status: r.status, sentAt: r.created_at, acceptedAmount: r.accepted_amount })) };
}

// POST from the shared page: {amount, paidOn, method, note}. Up to 3 waiting at a time.
export async function createLendRequest(token, b, { db = sql, now = Date.now() } = {}) {
  const p = await personByToken(db, token);
  if (!p) throw httpError(404, 'This link is not valid any more. Ask for a new one.');
  const amount = Number(b?.amount);
  if (!(amount > 0) || amount > 1e9) throw httpError(400, 'Enter the amount you paid');
  const paidOn = String(b?.paidOn || istToday(now));
  if (!isDay(paidOn) || paidOn > istToday(now) || paidOn < '2000-01-01') throw httpError(400, 'Enter the date you paid (not in the future)');
  const method = String(b?.method || 'upi');
  if (!['upi', 'bank', 'cash', 'other'].includes(method)) throw httpError(400, 'How did you pay? UPI, bank, cash or other');
  const [w] = await db.query(`SELECT count(*)::int n FROM wealth_lend_requests WHERE person_id = $1 AND status = 'pending'`, [p.id]);
  if (w.n >= 3) throw httpError(429, 'You already have 3 payments waiting for confirmation');
  const [ins] = await withActor(db, 'lend-link', [[`INSERT INTO wealth_lend_requests (person_id, amount, paid_on, method, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.id, r2(amount), paidOn, method, text(b?.note, 200)]]]);
  return { stored: true, requestId: ins[0].id };
}

// Owner side: waiting requests for the bell and the People page.
export async function pendingLendRequests(uid, { db = sql } = {}) {
  return db.query(`SELECT r.id, r.person_id, p.name, r.amount::float8 AS amount, r.paid_on::text AS paid_on, r.method, r.note, r.created_at
    FROM wealth_lend_requests r JOIN wealth_people p ON p.id = r.person_id AND p.user_id = $1
    WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 50`, [uid]);
}

// POST /api/loans/requests/decide {requestId, decision: accept|decline, amount?, paidOn?, accountId? (none = cash),
//   addToBalance? (default true when an account is chosen), closeLend? (default: when it covers what is owed)}
export async function decideLendRequest(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  if (!isUuid(b?.requestId)) throw httpError(400, 'requestId must be a request id');
  const [r] = await db.query(`SELECT r.*, r.amount::float8 AS amt, r.paid_on::text AS day, p.name, p.id AS pid FROM wealth_lend_requests r
    JOIN wealth_people p ON p.id = r.person_id AND p.user_id = $2 WHERE r.id = $1`, [b.requestId, uid]);
  if (!r) throw httpError(404, 'Request not found');
  if (r.status !== 'pending') throw httpError(409, 'This request was already ' + r.status);
  const decision = String(b?.decision || '');
  if (decision === 'decline') {
    if (dryRun) return { dryRun, decision };
    await withActor(db, actor, [[`UPDATE wealth_lend_requests SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'`, [r.id]]]);
    return { stored: true, decision };
  }
  if (decision !== 'accept') throw httpError(400, 'decision must be accept or decline');
  const amount = b.amount == null || b.amount === '' ? r.amt : Number(b.amount);
  if (!(amount > 0) || amount > 1e12) throw httpError(400, 'amount must be more than 0');
  const on = b.paidOn ? String(b.paidOn) : r.day;
  if (!isDay(on) || on > istToday(now)) throw httpError(400, 'paidOn must be a date, not in the future');
  let acct = null;
  if (b.accountId) {
    if (!isUuid(b.accountId)) throw httpError(400, 'accountId must be an account id');
    [acct] = await db.query(`SELECT a.id, a.account_name, a.bank_name, s.valuation FROM wealth_accounts a JOIN wealth_account_subtypes s ON s.code = a.subtype_code
      WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'active'`, [b.accountId, uid]);
    if (!acct) throw httpError(404, 'Account not found');
    if (acct.valuation !== 'balance') throw httpError(400, 'Pick a bank account (savings or current)');
  }
  const o = await loansOverview(uid, { db, now });
  const person = o.people.find(p => p.id === r.pid);
  const owedBefore = person ? person.owed : 0;
  const closeLend = b.closeLend == null ? amount >= owedBefore - 0.004 : !!b.closeLend;
  const addToBalance = !!acct && b.addToBalance !== false;
  let latest = null;
  if (addToBalance) [latest] = await db.query(`SELECT balance::float8 AS balance, as_of FROM wealth_v_latest_balances WHERE account_id = $1`, [acct.id]);
  if (addToBalance && (!latest || latest.balance == null)) throw httpError(409, `${acct.account_name} has no recorded balance to add to — record its balance first, or untick "add to balance"`);
  const newBalance = addToBalance ? r2(latest.balance + amount) : null;
  const summary = { decision, person: r.name, amount: r2(amount), paidOn: on, account: acct ? acct.account_name : 'Cash (no bank)', addToBalance, newBalance,
    closeLend, owedBefore, owedAfter: closeLend ? 0 : r2(Math.max(0, owedBefore - amount)) };
  if (dryRun) return { dryRun, ...summary };
  const note = `Paid back via shared link (${r.method}${r.note ? ': ' + r.note : ''})`;
  const stmts = [[`WITH t AS (
      INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref)
      SELECT $1, 'transfer', 'Transfer received', $2, $3, '', $4::uuid, $5, $6 WHERE $4::uuid IS NOT NULL
      ON CONFLICT DO NOTHING RETURNING id),
    e AS (INSERT INTO wealth_person_entries (person_id, direction, amount, occurred_on, transaction_id, note)
      SELECT $7, 'in', $3, $5, (SELECT id FROM t), $8 RETURNING id)
    UPDATE wealth_lend_requests SET status = 'accepted', decided_at = now(), accepted_amount = $3, account_id = $4::uuid,
      transaction_id = (SELECT id FROM t), balance_added = $9, closed_lend = $10
    WHERE id = $11 AND status = 'pending' RETURNING id, transaction_id`,
    [uid, `${r.name} · paid back (${r.method})`, r2(amount), acct ? acct.id : null, on, 'lend-request:' + r.id, r.pid, note, addToBalance, closeLend, r.id]]];
  if (addToBalance) {
    const asOf = new Date(Math.max(now, new Date(latest.as_of).getTime() + 1000)).toISOString();
    stmts.push([`INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note) VALUES ($1, $2, $3, 'reported', $4)`,
      [acct.id, asOf, newBalance, `+₹${r2(amount)} paid back by ${r.name} (owner accepted; last balance ₹${latest.balance} + this payment)`]]);
    stmts.push([`UPDATE wealth_accounts SET current_balance = $2, balance_as_of = $3, balance_status = 'stale', updated_at = now() WHERE id = $1`, [acct.id, newBalance, asOf]]);
  }
  if (closeLend) stmts.push([`UPDATE wealth_people SET status = 'settled', updated_at = now() WHERE id = $1`, [r.pid]]);
  const [upd] = await withActor(db, actor, stmts);
  if (!upd.length) throw httpError(409, 'This request was already decided');
  return { stored: true, transactionId: upd[0].transaction_id, ...summary };
}

// POST from the shared page: {entryId | shareId, body} — a remark on one row. Only rows of the person the link belongs to;
// up to 20 remarks a day per person (the owner answers from the People page).
export async function addLendComment(token, b, { db = sql, now = Date.now() } = {}) {
  const p = await personByToken(db, token);
  if (!p) throw httpError(404, 'This link is not valid any more. Ask for a new one.');
  const body = text(String(b?.body ?? '').replace(/[\u0000-\u001f]/g, ' '), 300);
  if (!body) throw httpError(400, 'Write your comment first');
  const byEntry = b?.entryId != null;
  if (byEntry === (b?.shareId != null)) throw httpError(400, 'Choose a row to comment on');
  const id = byEntry ? b.entryId : b.shareId;
  if (!isUuid(id)) throw httpError(400, 'Choose a row to comment on');
  const [row] = byEntry
    ? await db.query(`SELECT e.id FROM wealth_person_entries e WHERE e.id = $1 AND e.person_id = $2 AND e.status <> 'removed'`, [id, p.id])
    : await db.query(`SELECT sh.id FROM wealth_bill_split_shares sh JOIN wealth_bill_splits s ON s.id = sh.split_id AND s.status = 'active' WHERE sh.id = $1 AND sh.person_id = $2`, [id, p.id]);
  if (!row) throw httpError(404, 'That row was not found');
  const since = new Date(now - 24 * 3600e3).toISOString();
  const [w] = await db.query(`SELECT count(*)::int n FROM wealth_lend_comments WHERE person_id = $1 AND author = 'person' AND created_at > $2`, [p.id, since]);
  if (w.n >= 20) throw httpError(429, 'You have sent a lot of comments today. Please try again tomorrow.');
  const [ins] = await withActor(db, 'lend-link', [[`INSERT INTO wealth_lend_comments (person_id, entry_id, share_id, author, body) VALUES ($1,$2,$3,'person',$4) RETURNING id`,
    [p.id, byEntry ? id : null, byEntry ? null : id, body]]]);
  return { stored: true, commentId: ins[0].id };
}
