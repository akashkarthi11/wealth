// Offers screens (offers.js, 2026-11-14): the sentence the owner reads, the example amount, the presets, and the guarantee that the
// browser's arithmetic is the same as the server's. offers.js is evaluated in a sandbox with stand-ins for app.js's helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migratedDb } from './helpers/pglite.mjs';
import { createAccount } from '../../api/_ingest.js';
import { saveOffer, computeEarning, listOffers } from '../../api/_offers.js';
import { upsertRewardProgram } from '../../api/_rewards.js';

const src = readFileSync(new URL('../../offers.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function load() {
  const ctx = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]), money: v => '₹' + Number(v).toFixed(2), api: async () => ({}), alert() {}, confirm: () => true, activeView: 'rewards',
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } },
    Number, String, Date, Math, Object, JSON, Array, Set, Intl, console, setTimeout };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return ctx;
}
const row = (o = {}) => ({ reward_unit: 'cashback', benefit_type: 'percent', benefit_value: 5, block_amount: null, max_benefit: null, min_spend: null, max_spend: null, merchants: [], payment_mode: 'any',
  weekdays: [], valid_from: null, valid_to: null, frequency: 'unlimited', max_uses: null, period: 'none', period_max_uses: null, period_max_benefit: null, cycle_day: null, apply_mode: 'auto',
  coupon_code: '', exclusive_group: '', program_id: null, ...o });
const MONIES = { id: 'p1', name: 'Slice Monies', unit: 'Monies', inr_per_unit: 0.01 }, PTS = { id: 'p2', name: 'Roar points', unit: 'points', inr_per_unit: null };

test('the sentence says what you get, for which payments, and the limits', () => {
  const c = load();
  assert.equal(c.ofSentence(row({ benefit_value: 5, max_benefit: 100, merchants: ['swiggy'], min_spend: 249, payment_mode: 'card', period: 'cycle', cycle_day: 10, period_max_benefit: 1500 }), []),
    'Get 5% cashback (up to ₹100 per payment) on payments to swiggy of ₹249 or more, paid with this card. Up to ₹1,500 per billing cycle (statement day 10).');
  assert.equal(c.ofSentence(row({ benefit_type: 'percent', benefit_value: 20, max_benefit: 100, min_spend: 249, max_spend: 5000, payment_mode: 'upi', frequency: 'one_time', apply_mode: 'ask', merchants: ['zepto'] }), []),
    'Get 20% cashback (up to ₹100 per payment) on payments to zepto of ₹249 to ₹5,000, paid by UPI. Once only. You confirm each time (it must be activated first).');
  assert.equal(c.ofSentence(row({ reward_unit: 'points', benefit_type: 'per_block', benefit_value: 4, block_amount: 150, program_id: 'p2' }), [PTS]), 'Get 4 points per ₹150 on any payment.');
  assert.equal(c.ofSentence(row({ reward_unit: 'monies', benefit_value: 1, program_id: 'p1', weekdays: [0, 6], frequency: 'limited', max_uses: 3 }), [MONIES]), 'Get 1% back as Monies on any payment, on Sun, Sat. First 3 times only.');
  assert.equal(c.ofSentence(row({ reward_unit: 'discount', benefit_type: 'flat', benefit_value: 100 }), []), 'Get ₹100 off on any payment.');
  assert.equal(c.ofSentence(row({ merchants: ['swiggy'] }), [], true), 'Get 5% cashback on payments to swiggy.', 'short form has no limits');
  assert.equal(c.ofSentence(row({ valid_from: '2026-11-01', valid_to: '2026-12-31', period: 'month', period_max_uses: 2 }), []).includes('2 times per month'), true);
});

test('the example: a payment outside the minimum / maximum is not eligible; points need their program', () => {
  const c = load();
  const spark = row({ benefit_value: 20, max_benefit: 100, min_spend: 249, max_spend: 5000 });
  assert.equal(c.ofExampleText(spark, 500, []), '₹500 payment → ₹100 cashback');
  assert.match(c.ofExampleText(spark, 200, []), /not eligible \(minimum ₹249\)/);
  assert.match(c.ofExampleText(spark, 6000, []), /not eligible \(maximum ₹5,000\)/);
  const monies = row({ reward_unit: 'monies', benefit_value: 1, program_id: 'p1' });
  assert.equal(c.ofExampleText(monies, 500, [MONIES]), '₹500 payment → 500 Monies');
  assert.match(c.ofExampleText(monies, 500, []), /pick the reward program/);
  assert.equal(c.ofExampleText(row({ reward_unit: 'points', benefit_type: 'per_block', benefit_value: 4, block_amount: 150, program_id: 'p2' }), 400, [PTS]), '₹400 payment → 8 points');
});

test('the browser works out the same amount as the server (percent, flat, per block, caps, points through the rate)', () => {
  const c = load();
  const offers = [
    row(), row({ benefit_value: 12.5, max_benefit: 30 }), row({ benefit_type: 'flat', benefit_value: 50 }), row({ benefit_type: 'per_block', benefit_value: 5, block_amount: 100 }),
    row({ reward_unit: 'discount', benefit_value: 20, max_benefit: 75 }), row({ reward_unit: 'monies', benefit_value: 1, program_id: 'p1' }), row({ reward_unit: 'monies', benefit_value: 2.5, max_benefit: 4000, program_id: 'p1' }),
    row({ reward_unit: 'points', benefit_type: 'per_block', benefit_value: 4, block_amount: 150, program_id: 'p2' }), row({ reward_unit: 'points', benefit_value: 10, program_id: 'p2' }),
    row({ reward_unit: 'points', benefit_value: 1, program_id: 'p2' }), row({ reward_unit: 'cashback', benefit_type: 'per_block', benefit_value: 3, block_amount: 0 }),
  ];
  const progs = { p1: MONIES, p2: PTS };
  for (const o of offers) for (const a of [1, 99.99, 100, 149, 150, 800, 2300, 12345.67]) {
    const mine = c.ofCompute(o, a, [MONIES, PTS]);
    const theirs = computeEarning(o, a, o.program_id ? progs[o.program_id] : null);
    const t = theirs == null ? null : theirs.amount;
    // a per-block with a zero block cannot be saved at all; the server divides by zero there, the browser refuses: both are "no amount"
    if (o.benefit_type === 'per_block' && !(o.block_amount > 0)) { assert.equal(mine, null); continue; }
    assert.equal(mine, t, JSON.stringify(o) + ' @ ' + a);
  }
});

test('every starting template makes an offer the server accepts', async () => {
  const c = load();
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const card = (await createAccount(u.id, { subtype: 'credit_card', institution: 'HDFC Bank', name: 'Swiggy Card' }, { db: a })).account.id;
  const prog = (await upsertRewardProgram(u.id, { programKey: 'monies', provider: 'Slice', name: 'Slice Monies', unit: 'Monies', inrPerUnit: 0.01, rateSource: 'test', accountId: card }, { db: a })).programId;
  const presets = vm.runInContext('OF_PRESETS', c), ofBlank = vm.runInContext('ofBlank', c), ofFromRow = vm.runInContext('ofFromRow', c);
  assert.ok(presets.length >= 8);
  for (const p of presets) {
    const body = { ...ofBlank(card), ...p.fill, benefitValue: 5, blockAmount: 150, cycleDay: 10, periodMaxBenefit: 1000, title: p.title, programId: ['points', 'coins', 'monies'].includes(p.fill.rewardUnit) ? prog : '', preset: p.key };
    const r = await saveOffer(u.id, body, { db: a });
    assert.ok(r.saved, p.key);
  }
  const saved = (await listOffers(u.id, { db: a })).offers;
  assert.equal(saved.length, presets.length);
  // and the sentence of a saved row reads back without losing anything
  const spark = saved.find(o => o.preset === 'spark');
  assert.match(c.ofSentence(spark, []), /Once only/); assert.match(c.ofSentence(spark, []), /You confirm each time/);
  assert.equal(spark.apply_mode, 'ask'); assert.equal(spark.max_spend, null, 'no invented maximum');
  // a saved row can be edited: form -> body -> same row
  const form = ofFromRow(spark);
  assert.deepEqual(Object.keys(ofBlank('')).sort(), Object.keys(form).sort(), 'the form model has every field');
  await saveOffer(u.id, { ...form, benefitValue: 25 }, { db: a });
  assert.equal((await listOffers(u.id, { db: a })).offers.find(o => o.id === spark.id).benefit_value, 25);
});

test('everything shown is escaped, and empty data never throws', () => {
  const c = load(), evil = '<img src=x onerror=alert(1)>';
  const o = { ...row({ merchants: [evil] }), id: 'x', title: evil, account_id: 'a', verify_status: 'to_verify', active: true, notes: evil, source_url: 'https://e.test/?a="b', bank_name: evil, account_name: 'x', standing: {}, uses_count: 0 };
  for (const html of [c.ofOfferCardHtml(o, []), c.ofRuleHtml(o, []), c.rewardRowTag({ rewards: [{ title: evil, kind: 'cashback', inr: 5, status: 'expected', id: 'e' }] }),
    c.rewardRowDetail({ id: 't', kind: 'expense', account_id: 'a', rewards: [{ title: evil, kind: 'points', units: 5, unit: evil, status: 'expected', id: 'e' }] }),
    c.rewardsEarningsHtml({ earnings: [{ id: 'e', title: evil, kind: 'cashback', inr: 5, status: 'expected', tx_description: evil, used_on: '2026-11-10', account: evil, suggest: { transactionId: 'c', amount: 5, date: '2026-11-11', category: evil } }], earningTotals: {} }),
    c.ofPendItemHtml({ id: 't', kind: 'expense', description: evil, category: evil, date: '2026-11-10', account: evil, amount: 5, balance: 10, after: 5, delta: -5, offers: [{ id: 'o', title: evil, kind: 'cashback', amount: 1, rewardUnit: 'cashback', apply: 'auto', shadowed: null, verifyStatus: 'to_verify', couponCode: evil }] })])
    assert.doesNotMatch(html, /<img/, 'no raw tag');
  assert.equal(c.rewardEarnHtml({ id: 'p', unit: 'points' }).includes('No earning rule yet'), true);
  assert.equal(c.rewardsEarningsHtml({}), ''); assert.equal(c.rewardsOtherOffersHtml({}), ''); assert.equal(c.rewardRowTag({}), '');
  assert.equal(c.pendingTxHtml(), '');
});

test('the pending card: automatic offers are switched on, "ask me" and the shadowed ones are off', () => {
  const c = load();
  const t = { id: 't', kind: 'expense', description: 'Zepto', category: 'Groceries', date: '2026-11-10', account: 'Slice Savings', amount: 500, balance: 1000, after: 500, delta: -500, offers: [
    { id: 'a', title: 'Auto', kind: 'cashback', amount: 10, rewardUnit: 'cashback', apply: 'auto', shadowed: null, verifyStatus: 'verified' },
    { id: 'b', title: 'Spark', kind: 'cashback', amount: 50, rewardUnit: 'cashback', apply: 'ask', shadowed: null, verifyStatus: 'verified' },
    { id: 'c', title: 'Worse', kind: 'cashback', amount: 5, rewardUnit: 'cashback', apply: 'auto', shadowed: 'Auto', verifyStatus: 'verified' }] };
  const html = c.ofPendItemHtml(t);
  const box = id => html.match(new RegExp('data-of-apply="' + id + '"([^>]*)>'))[1];
  assert.match(box('a'), /checked/); assert.doesNotMatch(box('b'), /checked/); assert.doesNotMatch(box('c'), /checked/); assert.match(box('c'), /disabled/);
  assert.match(html, /needs activation/i); assert.match(html, /is better/);
  assert.match(html, /Balance ₹1000\.00/);
});

test('wiring: script is loaded after app.js, checked and published by the build', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/app.js') < html.indexOf('/offers.js'), 'offers.js loads after app.js');
  assert.match(html, /\/offers\.js\?v=/);
  const v = readFileSync(new URL('../validate-homepage.mjs', import.meta.url), 'utf8');
  assert.match(v, /offers\.js/); assert.match(v, /copyFileSync/);
  const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  for (const s of ["ofCall('rewardsAddButtonHtml')", "ofCall('rewardEarnHtml',p)", "ofCall('rewardRowTag',x)", "ofCall('rewardRowDetail',x)", "ofCall('rewardsEarningsHtml',d)"]) assert.ok(app.includes(s), s);
  // nothing in offers.js redefines a top-level name that app.js already defines (a second `const` of the same name stops the whole script)
  const top = s => new Set([...s.matchAll(/^(?:const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
  const clash = [...top(src)].filter(n => top(app.replace(/\r\n/g, '\n')).has(n));
  assert.deepEqual(clash, [], 'names defined in both files');
});
