// Screenshot upload (migration 0031, 2026-11-14): a payment screenshot is read by a vision model through the Vercel AI Gateway
// and becomes pending transactions for the uploading user. The model is faked here; nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { saveScreenshot, readScreenshot, listScreenshots, removeScreenshot, checkPayments, userAccounts, readingConfigured } from '../../api/_screenshots.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const png = (n = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('shot' + n)]).toString('base64');
const env = { AI_GATEWAY_API_KEY: 'k' };

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const mk = async (key, bank, name, sub) => (await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,$2,$3,$4,$5,$5,'INR') RETURNING id`, [u.id, key, bank, name, sub]))[0].id;
  const sav = await mk('hdfc', 'HDFC', 'Savings', 'savings'), card = await mk('sbi', 'SBI', 'Card', 'credit_card');
  const [other] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'ox','Owner Bank','Savings','savings','savings','INR') RETURNING id`, [o.id]);
  return { a, uid: u.id, other: o.id, otherAcc: other.id, sav, card };
}
const model = reply => { const calls = []; const f = async (url, o) => { calls.push({ url, body: JSON.parse(o.body), headers: o.headers }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }) }; }; return { f, calls }; };
const upload = async (a, uid, n = 0) => (await saveScreenshot(uid, { name: 'pay ' + n + '.jpg', data: png(n) }, { db: a })).id;

test('a screenshot becomes pending transactions for its owner; the image is deleted after reading', async () => {
  const { a, uid, other, sav } = await setup();
  const id = await upload(a, uid);
  const m = model({ transactions: [{ date: '2026-11-13', kind: 'expense', category: 'Food', description: 'Cafe Aroma', amount: 250.5, accountId: sav, reference: 'UPI123456' },
    { date: '2026-11-13', kind: 'transfer', category: 'Transfer sent', description: 'Asha', amount: '1,000', accountId: sav, reference: null }], note: '' });
  const r = await readScreenshot(uid, id, { db: a, env, fetchFn: m.f, now: NOW });
  assert.equal(r.added, 2);
  const t = await a.query(`SELECT kind, amount::float8 amt, user_id, account_id, review_status, external_ref, description FROM wealth_transactions ORDER BY amount`);
  assert.deepEqual(t.map(x => [x.kind, x.amt, x.user_id === uid, x.review_status]), [['expense', 250.5, true, 'pending'], ['transfer', 1000, true, 'pending']]);
  assert.ok(t.some(x => x.external_ref === 'ref:UPI123456') && t.some(x => x.external_ref === 'shot:' + id + ':2'));
  assert.match(t.find(x => x.amt === 250.5).description, /ref UPI123456/);
  const [row] = await a.query(`SELECT status, found, image FROM wealth_upload_screenshots WHERE id=$1`, [id]);
  assert.deepEqual([row.status, row.found, row.image], ['read', 2, null]);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions WHERE user_id=$1`, [other]))[0].n, 0);
  assert.equal(m.calls[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
  assert.equal(m.calls[0].body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(m.calls[0].headers.Authorization, 'Bearer k');
});

test('only the user\'s own accounts are accepted; the model\'s unknown or foreign account is skipped with a reason', async () => {
  const { a, uid, otherAcc, sav } = await setup();
  const id = await upload(a, uid);
  const m = model({ transactions: [{ date: '2026-11-13', kind: 'expense', category: 'Food', description: 'A', amount: 10, accountId: otherAcc }, { date: '2026-11-13', kind: 'expense', category: 'Food', description: 'B', amount: 20, accountId: null }, { date: '2026-11-13', kind: 'expense', category: 'Food', description: 'C', amount: 30, accountId: sav }] });
  const r = await readScreenshot(uid, id, { db: a, env, fetchFn: m.f, now: NOW });
  assert.equal(r.added, 1);
  assert.match(r.note, /which account/);
  assert.deepEqual((await a.query(`SELECT amount::float8 amt FROM wealth_transactions`)).map(x => x.amt), [30]);
});

test('a chosen account is used for every payment, and must be the user\'s own', async () => {
  const { a, uid, otherAcc, card } = await setup();
  const id = await upload(a, uid);
  const m = model({ transactions: [{ date: '2026-11-13', kind: 'expense', category: 'Food', description: 'A', amount: 10, accountId: null }] });
  await assert.rejects(readScreenshot(uid, id, { chosenAccountId: otherAcc, db: a, env, fetchFn: m.f, now: NOW }), e => e.status === 400);
  await readScreenshot(uid, id, { chosenAccountId: card, db: a, env, fetchFn: m.f, now: NOW });
  assert.equal((await a.query(`SELECT account_id FROM wealth_transactions`))[0].account_id, card);
});

test('model output is never trusted: bad kind, amount, date, huge or future values are dropped; at most 20 payments', () => {
  const accounts = [{ id: 'a1' }];
  const ok = { date: '2026-11-13', kind: 'expense', category: 'Food', description: 'x', amount: 5, accountId: 'a1' };
  const parsed = { transactions: [ok, { ...ok, kind: 'gift' }, { ...ok, amount: -1 }, { ...ok, amount: 1e12 }, { ...ok, date: '13/11/2026' }, { ...ok, date: '2026-12-31' }, { ...ok, category: '' }, ...Array.from({ length: 30 }, () => ok)] };
  const { clean } = checkPayments(parsed, accounts, { now: NOW });
  assert.equal(clean.length, 1 + 13, 'only valid rows out of the first 20 entries');
  assert.deepEqual(checkPayments('not an object', accounts).clean, []);
});

test('answer wrapped in code fences is still understood; unreadable answers mark the screenshot failed and add nothing', async () => {
  const { a, uid, sav } = await setup();
  const id1 = await upload(a, uid, 1);
  await readScreenshot(uid, id1, { db: a, env, fetchFn: model('```json\n' + JSON.stringify({ transactions: [{ date: '2026-11-13', kind: 'expense', category: 'Food', description: 'A', amount: 10, accountId: sav }] }) + '\n```').f, now: NOW });
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions`))[0].n, 1);
  const id2 = await upload(a, uid, 2);
  await assert.rejects(readScreenshot(uid, id2, { db: a, env, fetchFn: model('sorry, cannot help').f, now: NOW }), e => e.status === 502);
  const [row] = await a.query(`SELECT status, image FROM wealth_upload_screenshots WHERE id=$1`, [id2]);
  assert.deepEqual([row.status, row.image], ['failed', null]);
  const id3 = await upload(a, uid, 3);
  const down = { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
  await assert.rejects(readScreenshot(uid, id3, { db: a, env, fetchFn: async () => down, now: NOW }), e => e.status === 502 && /rate limited/.test(e.message));
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions`))[0].n, 1);
});

test('the same payment is not added twice: same reference already recorded (also from another source)', async () => {
  const { a, uid, sav } = await setup();
  await a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on,external_ref) VALUES($1,'expense','Food','Cafe · UPI ref UPI999',50,'',$2,'2026-11-12','gmail:abc')`, [uid, sav]);
  const id = await upload(a, uid);
  const m = model({ transactions: [{ date: '2026-11-12', kind: 'expense', category: 'Food', description: 'Cafe', amount: 50, accountId: sav, reference: 'UPI999' }, { date: '2026-11-12', kind: 'expense', category: 'Food', description: 'Tea', amount: 20, accountId: sav, reference: 'UPI777' }] });
  const r = await readScreenshot(uid, id, { db: a, env, fetchFn: m.f, now: NOW });
  assert.equal(r.added, 1);
  assert.match(r.note, /already recorded/);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_transactions`))[0].n, 2);
});

test('the same image cannot be uploaded twice; a failed one can be removed and sent again; limits and isolation', async () => {
  const { a, uid, other } = await setup();
  const id = await upload(a, uid, 1);
  await assert.rejects(saveScreenshot(uid, { name: 'x', data: png(1) }, { db: a }), e => e.status === 409);
  await assert.rejects(removeScreenshot(other, id, { db: a }), e => e.status === 404);
  await a.query(`UPDATE wealth_upload_screenshots SET status='failed', image=NULL WHERE id=$1`, [id]);
  await removeScreenshot(uid, id, { db: a });
  await upload(a, uid, 1);
  await assert.rejects(saveScreenshot(uid, { name: 'x', data: 'AAAA' }, { db: a }), e => e.status === 400, 'not an image');
  await assert.rejects(saveScreenshot(uid, { name: 'x', data: Buffer.alloc(3.5 * 1024 * 1024, 1).toString('base64') }, { db: a }), e => e.status === 400, 'too large');
  assert.deepEqual((await listScreenshots(other, { db: a })), []);
  assert.ok(!('image' in (await listScreenshots(uid, { db: a }))[0]), 'list never returns the image');
  for (let i = 10; i < 39; i++) await saveScreenshot(uid, { name: 'n', data: png(i) }, { db: a }).catch(() => {});
  await assert.rejects(saveScreenshot(uid, { name: 'n', data: png(99) }, { db: a }), e => e.status === 429);
});

test('a read screenshot cannot be read again, and cannot be removed to be sent again', async () => {
  const { a, uid, sav } = await setup();
  const id = await upload(a, uid);
  const m = model({ transactions: [{ date: '2026-11-13', kind: 'expense', category: 'Food', description: 'A', amount: 10, accountId: sav }] });
  await readScreenshot(uid, id, { db: a, env, fetchFn: m.f, now: NOW });
  await assert.rejects(readScreenshot(uid, id, { db: a, env, fetchFn: m.f, now: NOW }), e => e.status === 404);
  await assert.rejects(removeScreenshot(uid, id, { db: a }), e => e.status === 404);
  assert.equal(m.calls.length, 1);
});

test('reading is off without the AI Gateway key; accounts offered to the user are only their own cash and card accounts', async () => {
  assert.equal(readingConfigured({}), false);
  assert.equal(readingConfigured({ AI_GATEWAY_API_KEY: 'k' }), true);
  const { a, uid } = await setup();
  assert.deepEqual((await userAccounts(uid, { db: a })).map(x => x.label).sort(), ['HDFC · Savings', 'SBI · Card']);
});

test('wiring: password first, key check before saving, upload page accepts only Excel and screenshots', () => {
  const route = read('api/_routes/uploads.js');
  assert.ok(route.indexOf('Password is incorrect') < route.indexOf('readScreenshot('), 'password is checked before reading');
  assert.ok(route.indexOf('readingConfigured(aiEnv)') < route.indexOf('saveScreenshot(uid'), 'key is checked before the image is saved');
  assert.match(route, /VERCEL_OIDC_TOKEN/);
  const app = read('app.js');
  assert.match(app, /accept="\.xlsx,image\/png,image\/jpeg,image\/webp"/);
  assert.doesNotMatch(app, /csvParse|\.csv/);
  assert.match(read('scripts/migrations/0031_upload_screenshots.sql'), /CREATE TABLE IF NOT EXISTS wealth_upload_screenshots/);
  assert.doesNotMatch(read('scripts/migrations/0031_upload_screenshots.sql'), /\bDROP TABLE\b|\bTRUNCATE\b|DELETE FROM|CREATE TRIGGER/i);
});
