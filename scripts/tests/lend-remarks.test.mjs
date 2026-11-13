// Lending remarks (migration 0026, 2026-11-12): the owner edits an entry's description and answers remarks; on the shared page
// the person sees the description and can comment on each row. Comments are validated against the link's own person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { addPersonEntry, createSplit, loansOverview, setEntryNote, addOwnerComment } from '../../api/_loans.js';
import { shareLink, publicLendView, addLendComment } from '../../api/_lendshare.js';
import { viewHtml } from '../../api/_routes/lend-view.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,current_balance)
    VALUES($1,'hdfc','HDFC Bank','HDFC Bank Savings','savings','savings','INR',10000) RETURNING id`, [u.id]);
  await a.query(`INSERT INTO wealth_account_balances(account_id,as_of,balance,status) VALUES($1,'2026-11-10T10:00:00Z',10000,'verified')`, [acc.id]);
  const [t] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,'transfer','Transfer sent','UPI transfer to Arun S · ref 7781 secret-ish',5000,'',$2,'2026-11-01') RETURNING id`, [u.id, acc.id]);
  const [d] = await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,'expense','Food','Dinner',1000,'',$2,'2026-11-02') RETURNING id`, [u.id, acc.id]);
  await addPersonEntry(u.id, { name: 'Arun S', transactionIds: [t.id] }, { db: a, now: NOW });
  await addPersonEntry(u.id, { name: 'Arun S', direction: 'out', amount: 200, occurredOn: '2026-11-03', note: 'for the cab' }, { db: a, now: NOW });
  await createSplit(u.id, { transactionId: d.id, mode: 'equal', people: [{ name: 'Arun S' }, { name: 'Priya' }] }, { db: a, now: NOW });
  const ov = await loansOverview(u.id, { db: a, now: NOW });
  const arun = ov.people.find(p => p.name === 'Arun S'), priya = ov.people.find(p => p.name === 'Priya');
  const token = (await shareLink(u.id, { personId: arun.id }, { db: a })).path.slice(3);
  const tokenP = (await shareLink(u.id, { personId: priya.id }, { db: a })).path.slice(3);
  const item = (p, pred) => p.items.find(pred);
  return { a, uid: u.id, otherUid: o.id, arun, priya, token, tokenP, ov, item };
}

const arunItems = async (a, uid) => (await loansOverview(uid, { db: a, now: NOW })).people.find(p => p.name === 'Arun S').items;

test('owner edits the description of an entry; empty clears it; another user cannot', async () => {
  const { a, uid, otherUid } = await setup();
  const manual = (await arunItems(a, uid)).find(i => i.type === 'manual');
  assert.equal(manual.note, 'for the cab');
  const r = await setEntryNote(uid, { entryId: manual.entryId, note: '  cab to airport, 3 Nov  ' }, { db: a });
  assert.equal(r.note, 'cab to airport, 3 Nov');
  assert.equal((await arunItems(a, uid)).find(i => i.entryId === manual.entryId).note, 'cab to airport, 3 Nov');
  await setEntryNote(uid, { entryId: manual.entryId, note: '' }, { db: a });
  assert.equal((await arunItems(a, uid)).find(i => i.entryId === manual.entryId).note, null);
  await assert.rejects(setEntryNote(otherUid, { entryId: manual.entryId, note: 'x' }, { db: a }), e => e.status === 404);
  await assert.rejects(setEntryNote(uid, { entryId: 'nope', note: 'x' }, { db: a }), e => e.status === 400);
});

test('the shared page shows the owner\'s description, never the bank transaction text', async () => {
  const { a, uid, token } = await setup();
  const transfer = (await arunItems(a, uid)).find(i => i.type === 'transfer');
  await setEntryNote(uid, { entryId: transfer.entryId, note: 'loan for rent' }, { db: a });
  const v = await publicLendView(token, { db: a, now: NOW });
  const notes = v.items.map(i => i.note).filter(Boolean).sort();
  assert.deepEqual(notes, ['for the cab', 'loan for rent']);
  const raw = JSON.stringify(v);
  for (const leak of ['ref 7781', 'secret-ish', 'HDFC']) assert.ok(!raw.includes(leak), 'no ' + leak);
  assert.ok(v.items.every(i => i.entryId || i.shareId), 'every row can be commented on');
  assert.match(viewHtml(v), /“loan for rent”/);
});

test('a person comments on a row from the link; the owner sees it and answers; the answer shows on the shared page', async () => {
  const { a, uid, token } = await setup();
  const manual = (await arunItems(a, uid)).find(i => i.type === 'manual');
  const c = await addLendComment(token, { entryId: manual.entryId, body: 'I paid ₹100 of this in cash' }, { db: a, now: NOW });
  assert.ok(c.stored);
  const mine = (await arunItems(a, uid)).find(i => i.entryId === manual.entryId);
  assert.deepEqual(mine.comments.map(x => [x.author, x.body]), [['person', 'I paid ₹100 of this in cash']]);
  await addOwnerComment(uid, { entryId: manual.entryId, body: 'Ok, I will adjust it' }, { db: a });
  const v = await publicLendView(token, { db: a, now: NOW });
  const row = v.items.find(i => i.entryId === manual.entryId);
  assert.deepEqual(row.comments.map(x => [x.author, x.body]), [['person', 'I paid ₹100 of this in cash'], ['owner', 'Ok, I will adjust it']]);
  const html = viewHtml(v);
  assert.match(html, /class="cm cm-owner"/);
  assert.match(html, /class="cm cm-me"/);
  assert.match(html, /class="cform" data-entry=/);
});

test('a bill share can be commented on and answered too', async () => {
  const { a, uid, token } = await setup();
  const share = (await arunItems(a, uid)).find(i => i.type === 'bill');
  await addLendComment(token, { shareId: share.shareId, body: 'I did not order the dessert' }, { db: a, now: NOW });
  await addOwnerComment(uid, { shareId: share.shareId, body: 'Noted' }, { db: a });
  const row = (await publicLendView(token, { db: a, now: NOW })).items.find(i => i.shareId === share.shareId);
  assert.deepEqual(row.comments.map(x => x.author), ['person', 'owner']);
});

test('comment safety: bad link, someone else\'s row, empty, both ids, long text, HTML and the daily limit', async () => {
  const { a, uid, token, tokenP } = await setup();
  const arun = await arunItems(a, uid);
  const manual = arun.find(i => i.type === 'manual');
  await assert.rejects(addLendComment('x'.repeat(40), { entryId: manual.entryId, body: 'hi' }, { db: a }), e => e.status === 404);
  await assert.rejects(addLendComment(tokenP, { entryId: manual.entryId, body: 'hi' }, { db: a }), e => e.status === 404, 'Priya cannot comment on Arun\'s row');
  await assert.rejects(addLendComment(token, { entryId: manual.entryId, body: '   ' }, { db: a }), e => e.status === 400);
  await assert.rejects(addLendComment(token, { entryId: manual.entryId, shareId: manual.entryId, body: 'x' }, { db: a }), e => e.status === 400);
  await assert.rejects(addLendComment(token, { body: 'x' }, { db: a }), e => e.status === 400);
  await assert.rejects(addLendComment(token, { entryId: 'not-a-uuid', body: 'x' }, { db: a }), e => e.status === 400);
  await addLendComment(token, { entryId: manual.entryId, body: '<script>alert(1)</script>' + 'a'.repeat(400) }, { db: a, now: NOW });
  const stored = (await a.query(`SELECT body FROM wealth_lend_comments ORDER BY created_at DESC LIMIT 1`))[0].body;
  assert.equal(stored.length, 300, 'cut to 300 characters');
  const html = viewHtml(await publicLendView(token, { db: a, now: NOW }));
  assert.ok(!html.includes('<script>alert(1)'), 'HTML in a comment is escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)/);
  for (let i = 1; i < 20; i++) await addLendComment(token, { entryId: manual.entryId, body: 'c' + i }, { db: a, now: NOW });
  await assert.rejects(addLendComment(token, { entryId: manual.entryId, body: 'one too many' }, { db: a, now: NOW }), e => e.status === 429);
  // The limit is a day long: the next day it works again.
  await a.query(`UPDATE wealth_lend_comments SET created_at = now() - interval '2 days'`);
  assert.ok((await addLendComment(token, { entryId: manual.entryId, body: 'next day' }, { db: a, now: Date.now() })).stored);
});

test('owner answers only rows of their own people', async () => {
  const { a, uid, otherUid } = await setup();
  const manual = (await arunItems(a, uid)).find(i => i.type === 'manual');
  await assert.rejects(addOwnerComment(otherUid, { entryId: manual.entryId, body: 'hi' }, { db: a }), e => e.status === 404);
  await assert.rejects(addOwnerComment(uid, { entryId: manual.entryId, body: '' }, { db: a }), e => e.status === 400);
  await assert.rejects(addOwnerComment(uid, { body: 'hi' }, { db: a }), e => e.status === 400);
});

test('the migration is additive and the UI/route are wired', () => {
  const m = readFileSync(new URL('../migrations/0026_lend_comments.sql', import.meta.url), 'utf8');
  assert.match(m, /CREATE TABLE IF NOT EXISTS wealth_lend_comments/);
  assert.match(m, /author IN \('person', 'owner'\)/);
  assert.doesNotMatch(m, /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM/i);
  const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  for (const s of ['data-lend-note', 'data-lend-reply', '/api/loans/entries/note', '/api/loans/comments', 'Edit note']) assert.ok(app.includes(s), s);
  const route = readFileSync(new URL('../../api/_routes/loans.js', import.meta.url), 'utf8');
  assert.match(route, /'loans\/entries\/note': setEntryNote/);
  assert.match(route, /'loans\/comments': addOwnerComment/);
  const pub = readFileSync(new URL('../../api/_routes/lend-view.js', import.meta.url), 'utf8');
  assert.match(pub, /kind === 'comment'/);
  assert.match(pub, /lend-comment:/);
});
