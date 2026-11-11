// Shared lending link and "I've paid" requests (0023): link made once (only its hash stored), page shows that person's
// entries only, requests are limited, accepting records the money on a bank account (+ optional balance, close), decline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { addPersonEntry, createSplit, loansOverview } from '../../api/_loans.js';
import { shareLink, publicLendView, createLendRequest, decideLendRequest, validToken } from '../../api/_lendshare.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,current_balance)
    VALUES($1,'hdfc','HDFC Bank','HDFC Bank Savings','savings','savings','INR',10000) RETURNING id`, [u.id]);
  await a.query(`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-10T10:00:00Z',10000,'verified')`, [acc.id]);
  const [t] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,'transfer','Transfer sent','UPI transfer to Arun S · ref 7781 secret-ish',5000,'',$2,'2026-11-01') RETURNING id`, [u.id, acc.id]);
  const [d] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,'expense','Food','Dinner',1000,'',$2,'2026-11-02') RETURNING id`, [u.id, acc.id]);
  await addPersonEntry(u.id, { name: 'Arun S', transactionIds: [t.id] }, { db: a, now: NOW });
  await createSplit(u.id, { transactionId: d.id, mode: 'equal', people: [{ name: 'Arun S' }, { name: 'Priya' }] }, { db: a, now: NOW });   // Arun 333.33
  const pid = (await loansOverview(u.id, { db: a, now: NOW })).people.find(p => p.name === 'Arun S').id;
  return { a, uid: u.id, acc: acc.id, pid };
}

test('link: made once, only a hash stored, shows only that person; a new link replaces the old; turn off', async () => {
  const { a, uid, pid } = await setup();
  const r = await shareLink(uid, { personId: pid }, { db: a });
  const token = r.path.slice(3);
  assert.ok(validToken(token) && r.path.startsWith('/l/'));
  const [row] = await a.query(`SELECT share_token_hash FROM wealth_people WHERE id = $1`, [pid]);
  assert.ok(row.share_token_hash && !row.share_token_hash.includes(token), 'secret not stored');
  const v = await publicLendView(token, { db: a, now: NOW });
  assert.deepEqual([v.name, v.owed, v.items.length], ['Arun S', 5333.33, 2]);
  const raw = JSON.stringify(v);
  for (const leak of ['HDFC', 'ref 7781', 'Priya', 'Dinner at', 'account']) assert.ok(!raw.includes(leak), 'no ' + leak);
  const again = await shareLink(uid, { personId: pid }, { db: a });
  assert.equal(await publicLendView(token, { db: a, now: NOW }), null, 'old link stops working');
  await shareLink(uid, { personId: pid, action: 'revoke' }, { db: a });
  assert.equal(await publicLendView(again.path.slice(3), { db: a, now: NOW }), null);
  assert.equal(await publicLendView('x'.repeat(40), { db: a, now: NOW }), null);
});

test('request: validated, up to 3 waiting, shown to the owner (bell) and on the shared page', async () => {
  const { a, uid, pid } = await setup();
  const token = (await shareLink(uid, { personId: pid }, { db: a })).path.slice(3);
  await assert.rejects(createLendRequest(token, { amount: 0 }, { db: a, now: NOW }), /amount/);
  await assert.rejects(createLendRequest(token, { amount: 5, paidOn: '2027-01-01' }, { db: a, now: NOW }), /future/);
  await assert.rejects(createLendRequest(token, { amount: 5, method: 'crypto' }, { db: a, now: NOW }), /UPI/);
  await assert.rejects(createLendRequest('y'.repeat(40), { amount: 5 }, { db: a, now: NOW }), /not valid/);
  for (let i = 0; i < 3; i++) await createLendRequest(token, { amount: 100 + i, paidOn: '2026-11-11', method: 'upi', note: 'ref ' + i }, { db: a, now: NOW });
  await assert.rejects(createLendRequest(token, { amount: 5 }, { db: a, now: NOW }), /3 payments waiting/);
  const o = await loansOverview(uid, { db: a, now: NOW });
  assert.deepEqual([o.requests.length, o.requests[0].name, o.people.find(p => p.id === pid).requests], [3, 'Arun S', 3]);
  const v = await publicLendView(token, { db: a, now: NOW });
  assert.deepEqual(v.requests.map(r => r.status), ['pending', 'pending', 'pending']);
});

test('accept: received transfer on the bank account + paid-back entry + balance added + lend closed, in one go; decline', async () => {
  const { a, uid, pid, acc } = await setup();
  const token = (await shareLink(uid, { personId: pid }, { db: a })).path.slice(3);
  const { requestId } = await createLendRequest(token, { amount: 5333.33, paidOn: '2026-11-11', method: 'upi' }, { db: a, now: NOW });
  const dry = await decideLendRequest(uid, { requestId, decision: 'accept', accountId: acc }, { db: a, now: NOW, dryRun: true });
  assert.deepEqual([dry.newBalance, dry.closeLend, dry.owedAfter], [15333.33, true, 0]);
  const r = await decideLendRequest(uid, { requestId, decision: 'accept', accountId: acc }, { db: a, now: NOW });
  assert.ok(r.transactionId);
  const [tx] = await a.query(`SELECT kind, category, amount::float8 AS amount, account_id, external_ref FROM wealth_transactions WHERE id = $1`, [r.transactionId]);
  assert.deepEqual({ ...tx }, { kind: 'transfer', category: 'Transfer received', amount: 5333.33, account_id: acc, external_ref: 'lend-request:' + requestId });
  const [bal] = await a.query(`SELECT balance::float8 AS balance, status FROM wealth_v_latest_balances WHERE account_id = $1`, [acc]);
  const [ac] = await a.query(`SELECT current_balance::float8 AS b, balance_status FROM wealth_accounts WHERE id = $1`, [acc]);
  assert.deepEqual([bal.balance, bal.status, ac.b, ac.balance_status], [15333.33, 'reported', 15333.33, 'stale']);
  const p = (await loansOverview(uid, { db: a, now: NOW })).people.find(x => x.id === pid);
  assert.deepEqual([p.status, p.owed, p.history, p.requests], ['settled', 0, true, 0]);
  await assert.rejects(decideLendRequest(uid, { requestId, decision: 'accept' }, { db: a, now: NOW }), /already accepted/);
  // part payment in cash, keep the lend open; then decline another
  const t2 = (await shareLink(uid, { personId: pid }, { db: a })).path.slice(3);
  await addPersonEntry(uid, { personId: pid, direction: 'out', amount: 2000, occurredOn: '2026-11-11' }, { db: a, now: NOW });   // lends again → reopened
  const q2 = await createLendRequest(t2, { amount: 500, method: 'cash' }, { db: a, now: NOW });
  const r2 = await decideLendRequest(uid, { requestId: q2.requestId, decision: 'accept' }, { db: a, now: NOW });
  assert.deepEqual([r2.account, r2.addToBalance, r2.closeLend, r2.owedAfter], ['Cash (no bank)', false, false, 1500]);
  const q3 = await createLendRequest(t2, { amount: 99 }, { db: a, now: NOW });
  await decideLendRequest(uid, { requestId: q3.requestId, decision: 'decline' }, { db: a, now: NOW });
  const v = await publicLendView(t2, { db: a, now: NOW });
  assert.deepEqual([v.owed, v.requests[0].status], [1500, 'declined']);
  const [o] = await a.query(`SELECT id FROM wealth_users WHERE email = 'o@example.test'`);
  const [other] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('x@example.test','x','user') RETURNING id`);
  await assert.rejects(decideLendRequest(other.id, { requestId: q3.requestId, decision: 'decline' }, { db: a, now: NOW }), /not found/);
  assert.ok(o.id);
});

test('shared page: escapes what it shows, settled shows ₹0 without the form, bad link → 404 page', async () => {
  const { viewHtml, default: handler } = await import('../../api/_routes/lend-view.js');
  const html = viewHtml({ name: '<script>x</script>', owed: 100, lent: 100, repaid: 0, asOf: '2026-11-11', items: [{ on: '2026-11-11', label: 'Share of <b>x</b>', amount: 100, direction: 'out' }], requests: [] });
  assert.ok(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /I've paid/);
  const done = viewHtml({ name: 'A', owed: 0, lent: 100, repaid: 100, asOf: '2026-11-11', items: [], requests: [] });
  assert.match(done, /All settled[\s\S]*₹0/);
  assert.ok(!done.includes('id="paid"'));
  let status = 0, body = '';
  const res = { setHeader() {}, set statusCode(v) { status = v; }, get statusCode() { return status; }, end(b) { body = b || ''; } };
  await handler({ method: 'GET', url: '/api/lend-view?t=short', headers: {} }, res);
  assert.equal(status, 404);
});
