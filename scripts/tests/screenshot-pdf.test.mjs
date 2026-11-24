// PDF statements and the free Gemini reading path (owner's request 2026-11-24: "i need free" — Gemini's free tier
// covers image input at no charge per Google's own pricing page; the paid Vercel Gateway/Claude Haiku path used alone
// before is now a fallback, and never used for a PDF since its PDF shape through the Gateway is unverified).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { saveScreenshot, readScreenshot, readingConfigured, geminiConfigured, checkPayments, MAX_BYTES, MAX_PDF_BYTES, MAX_PAYMENTS, MAX_PDF_PAYMENTS } from '../../api/_screenshots.js';

process.env.WEALTH_SESSION_SECRET = 'test-only-session-secret-that-is-at-least-32-characters-long';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SRC = read('api/_screenshots.js');
const png = (n = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('shot' + n)]).toString('base64');
const pdf = (bytes = 2000) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes, 'x')]).toString('base64');

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const [sav] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency) VALUES($1,'hdfc','HDFC','Savings','savings','savings','INR') RETURNING id`, [u.id]);
  return { a, uid: u.id, sav: sav.id };
}
const upload = (a, uid, base64, name = 'statement.pdf') => saveScreenshot(uid, { name, data: base64 }, { db: a });
const geminiReply = (transactions, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ transactions, note: '' }) }] }, finishReason }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
});
const fakeGemini = reply => { const calls = []; const f = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => reply }; }; return { f, calls }; };
const fakeGateway = reply => { const calls = []; const f = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) }; }; return { f, calls }; };

test('a PDF is detected by its magic bytes and accepted up to its own, larger cap', async () => {
  const { a, uid } = await setup();
  const saved = await upload(a, uid, pdf(2000));
  assert.equal(saved.mime, 'application/pdf');
  await assert.rejects(upload(a, uid, pdf(MAX_PDF_BYTES + 1000), 'too-big.pdf'), /larger than 8 MB/);
});

test('the image cap is unchanged: a PDF-sized file does not make screenshots bigger too', async () => {
  const { a, uid } = await setup();
  assert.equal(MAX_BYTES, 3 * 1024 * 1024);
  assert.equal(MAX_PDF_BYTES, 8 * 1024 * 1024);
  const bigImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.alloc(MAX_BYTES + 1000, 'x')]).toString('base64');
  await assert.rejects(upload(a, uid, bigImage, 'big.png'), /larger than 3 MB/);
});

test('Gemini is tried first when configured, and reads a PDF the paid Gateway never sees', async () => {
  const { a, uid, sav } = await setup();
  const saved = await upload(a, uid, pdf());
  const g = fakeGemini(geminiReply([{ date: '2026-11-20', kind: 'expense', category: 'Groceries', description: 'Store', amount: 500, accountId: sav, reference: 'r1' }]));
  const r = await readScreenshot(uid, saved.id, { db: a, env: { GEMINI_API_KEY: 'gk', AI_GATEWAY_API_KEY: 'ak' }, fetchFn: g.f });
  assert.equal(r.added, 1);
  assert.equal(g.calls.length, 1, 'only Gemini was called; the Gateway never saw the PDF');
  assert.match(g.calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(g.calls[0].url, /key=gk/);
  assert.ok(g.calls[0].body.systemInstruction?.parts?.[0]?.text, 'the rules are sent as a system instruction');
  assert.equal(g.calls[0].body.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
  assert.equal(g.calls[0].body.generationConfig.responseMimeType, 'application/json', 'strict JSON is requested natively');
});

test('a PDF with no Gemini key throws a clear setup error and calls nothing, even if the paid key is set', async () => {
  const { a, uid } = await setup();
  const saved = await upload(a, uid, pdf());
  let called = false;
  const f = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  await assert.rejects(readScreenshot(uid, saved.id, { db: a, env: { AI_GATEWAY_API_KEY: 'ak' }, fetchFn: f }), /GEMINI_API_KEY/);
  assert.equal(called, false, 'no guess at an unverified PDF shape through the paid Gateway');
});

test('a screenshot still falls back to the paid Gateway when Gemini fails and both keys are set', async () => {
  const { a, uid, sav } = await setup();
  const saved = await upload(a, uid, png(1), 'pay.png');
  let geminiCalled = 0;
  const failingGemini = async () => { geminiCalled++; return { ok: false, status: 500, json: async () => ({ error: { message: 'overloaded' } }) }; };
  const gw = fakeGateway({ transactions: [{ date: '2026-11-20', kind: 'expense', category: 'Food', description: 'Cafe', amount: 100, accountId: sav, reference: 'r2' }], note: '' });
  const r = await readScreenshot(uid, saved.id, { db: a, env: { GEMINI_API_KEY: 'gk', AI_GATEWAY_API_KEY: 'ak' }, fetchFn: async (url, o) => url.includes('googleapis') ? failingGemini() : gw.f(url, o) });
  assert.equal(r.added, 1, 'the paid fallback still worked');
  assert.equal(geminiCalled, 1);
  assert.equal(gw.calls.length, 1);
});

test('a PDF never falls back to the Gateway even when both keys are set and Gemini fails', async () => {
  const { a, uid } = await setup();
  const saved = await upload(a, uid, pdf());
  let gatewayCalled = false;
  const f = async url => { if (!url.includes('googleapis')) { gatewayCalled = true; } return { ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) }; };
  await assert.rejects(readScreenshot(uid, saved.id, { db: a, env: { GEMINI_API_KEY: 'gk', AI_GATEWAY_API_KEY: 'ak' }, fetchFn: f }), /Gemini said/);
  assert.equal(gatewayCalled, false, 'the paid path is never asked to read a PDF, verified or not');
});

test('either key configures reading, and a PDF specifically still needs Gemini', () => {
  assert.equal(readingConfigured({ GEMINI_API_KEY: 'k' }), true);
  assert.equal(geminiConfigured({ GEMINI_API_KEY: 'k' }), true);
  assert.equal(geminiConfigured({ AI_GATEWAY_API_KEY: 'k' }), false);
});

test('a larger allowance is used for a PDF statement than for one payment screenshot', () => {
  assert.equal(MAX_PAYMENTS, 20);
  assert.equal(MAX_PDF_PAYMENTS, 150);
  const many = Array.from({ length: 30 }, (_, i) => ({ date: '2026-11-20', kind: 'expense', category: 'Food', description: 'x' + i, amount: 10, accountId: 'a', reference: 'r' + i }));
  const { clean: smallCap } = checkPayments({ transactions: many }, [{ id: 'a' }], { maxPayments: MAX_PAYMENTS });
  const { clean: bigCap } = checkPayments({ transactions: many }, [{ id: 'a' }], { maxPayments: MAX_PDF_PAYMENTS });
  assert.equal(smallCap.length, 20);
  assert.equal(bigCap.length, 30);
});

test('every Gemini call is audited, and the key never reaches the audit', async () => {
  const { a, uid, sav } = await setup();
  const saved = await upload(a, uid, pdf());
  const g = fakeGemini(geminiReply([{ date: '2026-11-20', kind: 'income', category: 'Salary', description: 'Pay', amount: 1000, accountId: sav, reference: 'r3' }]));
  await readScreenshot(uid, saved.id, { db: a, env: { GEMINI_API_KEY: 'super-secret-key' }, fetchFn: g.f });
  const [row] = await a.query(`SELECT provider, endpoint, ok FROM wealth_api_audit WHERE provider='Gemini Vision'`);
  assert.ok(row, 'the call was recorded');
  assert.equal(row.ok, true);
  assert.ok(!row.endpoint.includes('super-secret-key'), 'the key is redacted out of the stored endpoint');
  assert.match(row.endpoint, /key=REDACTED/);
});

test('wiring: Gemini is tried before the Gateway, and a PDF is refused to the Gateway path entirely', () => {
  const geminiFn = SRC.indexOf('async function callGemini');
  const dispatch = SRC.indexOf('async function callVisionModel');
  assert.ok(geminiFn > 0 && dispatch > geminiFn, 'callGemini exists ahead of the dispatcher that chooses it first');
  assert.match(SRC, /const geminiKey = await resolveGeminiKey\(db, env\)/, 'checks the stored key too, not only the env var');
  assert.match(SRC, /if \(geminiKey\) \{/);
  assert.match(SRC, /if \(isPdfMime\(mime\)\) throw err\(503, 'Reading a PDF statement needs a Gemini key/);
  assert.match(SRC, /DEFAULT_GEMINI_MODEL = 'gemini-3\.5-flash-lite'/);
});

test('the Gemini Vision reader appears in the one shared provider directory, with no key value in it', async () => {
  const { buildProviderDirectory, PROVIDER_KEYS, health } = await import('../../api/_lib/provider-directory.js');
  const { saveStoredProviderKey } = await import('../../api/_lib/provider-api-keys.js');
  const { a } = await setup();
  const { providers } = await buildProviderDirectory(a);
  const gemini = providers.find(p => p.key === 'gemini-vision');
  assert.ok(gemini, 'Gemini Vision is in the shared directory, not a separate copy');
  assert.equal(gemini.key_env, 'GEMINI_API_KEY');
  assert.ok(PROVIDER_KEYS.includes('gemini-vision'), 'so its key is editable from the generic provider-key route');
  assert.doesNotMatch(JSON.stringify(gemini), /"value":/);

  // loadStoredProviderKeyValue (used by health()) reads the key saved against the admin account specifically.
  const [admin] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('owner@example.test','x','admin') RETURNING id`);
  assert.equal((await health('gemini-vision', false, a)).status, 'needs_key');
  await saveStoredProviderKey(a, admin.id, 'gemini-vision', 'a-saved-gemini-key');
  const configured = await health('gemini-vision', false, a);
  assert.equal(configured.status, 'configured', 'a key saved from the card is read back by health()');
  assert.doesNotMatch(JSON.stringify(configured), /a-saved-gemini-key/, 'the saved value itself never comes back');
});

test('readingAvailable checks the stored key too, so the upload gate is not fooled by an env-only check', async () => {
  const { readingAvailable } = await import('../../api/_screenshots.js');
  const { saveStoredProviderKey } = await import('../../api/_lib/provider-api-keys.js');
  const { a } = await setup();
  assert.equal(await readingAvailable(a, {}), false);
  const [admin] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('owner2@example.test','x','admin') RETURNING id`);
  await saveStoredProviderKey(a, admin.id, 'gemini-vision', 'a-saved-gemini-key');
  assert.equal(await readingAvailable(a, {}), true, 'a key saved from the card, with no env var at all, is enough');
});
