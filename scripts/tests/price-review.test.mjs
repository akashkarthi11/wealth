// Price review (2026-11-12, migration 0025): a price that jumps far from the previous one is flagged (medium = yellow,
// high = red); the owner can reject it (the previous price is used again, the rejected row is kept) or change it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';
import { priceJumpSeverity, priceJumps, rejectPrice, changePrice, MEDIUM_PCT, HIGH_PCT } from '../../api/_pricereview.js';
import { collectIssues } from '../../api/_dataquality.js';

const NOW = Date.parse('2026-11-12T10:00:00Z');

async function setup({ usd = false } = {}) {
  const { db, a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [o] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('t@example.test','x','user') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency)
    VALUES($1,'broker-demat','Broker','Demat','investment','demat_equity','INR') RETURNING id`, [u.id]);
  const [ins] = await a.query(`INSERT INTO wealth_instruments(asset_class,symbol,name,currency,unit) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    usd ? ['us_equity', 'NVDA', 'NVIDIA', 'USD', 'share'] : ['indian_equity', 'TATSILV', 'Tata Silver ETF', 'INR', 'share']);
  await a.query(`INSERT INTO wealth_holdings(account_id,instrument_id,quantity,invested_value,as_of) VALUES($1,$2,104,2683.2,'2026-11-10T00:00:00Z')`, [acc.id, ins.id]);
  const price = (asOf, source, p, fx = null) => a.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price,fx_to_inr) VALUES($1,$2,$3,$4,$5)`, [ins.id, asOf, source, p, fx]);
  return { db, a, uid: u.id, otherUid: o.id, iid: ins.id, price };
}

test('severity: below 10% nothing, 10–30% medium (yellow), 30% and above high (red), either direction', () => {
  assert.equal(MEDIUM_PCT, 10); assert.equal(HIGH_PCT, 30);
  assert.equal(priceJumpSeverity(2), null);
  assert.equal(priceJumpSeverity(9.99), null);
  assert.equal(priceJumpSeverity(10), 'medium');
  assert.equal(priceJumpSeverity(-15), 'medium');
  assert.equal(priceJumpSeverity(29.9), 'medium');
  assert.equal(priceJumpSeverity(30), 'high');
  assert.equal(priceJumpSeverity(-60), 'high');
  assert.equal(priceJumpSeverity(17667), 'high');
  assert.equal(priceJumpSeverity(NaN), null);
});

test('a price 177× the previous one is flagged high with old and new price, source and time; a normal move is not', async () => {
  const { a, uid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 17.99);
  await price('2026-11-12T07:00:00Z', 'StockAnalysis.com real-time quote', 3196.3);
  const [j] = await priceJumps(uid, { db: a });
  assert.equal(j.symbol, 'TATSILV');
  assert.equal(j.severity, 'high');
  assert.equal(j.previous.price, 17.99);
  assert.equal(j.latest.price, 3196.3);
  assert.equal(j.latest.source, 'StockAnalysis.com real-time quote');
  assert.ok(j.changePct > 17000);
  const { a: a2, uid: uid2, price: p2 } = await setup();
  await p2('2026-11-11T10:00:00Z', 'Yahoo Finance', 100);
  await p2('2026-11-12T07:00:00Z', 'Yahoo Finance', 103);
  assert.deepEqual(await priceJumps(uid2, { db: a2 }), []);
});

test('a medium move (+12%) is yellow', async () => {
  const { a, uid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 100);
  await price('2026-11-12T07:00:00Z', 'Yahoo Finance', 112);
  const [j] = await priceJumps(uid, { db: a });
  assert.equal(j.severity, 'medium');
  assert.equal(j.changePct, 12);
});

test('only the owner of the holding sees it: another user gets nothing and cannot reject', async () => {
  const { a, otherUid, iid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 17.99);
  await price('2026-11-12T07:00:00Z', 'Yahoo Finance', 3196.3);
  assert.deepEqual(await priceJumps(otherUid, { db: a }), []);
  await assert.rejects(rejectPrice(otherUid, { instrumentId: iid, asOf: '2026-11-12T07:00:00Z', source: 'Yahoo Finance' }, { db: a }), e => e.status === 404);
});

test('reject: the previous price is used again, the rejected row is kept with who/when/why, and it cannot be rejected twice', async () => {
  const { a, uid, iid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 17.99);
  await price('2026-11-12T07:00:00Z', 'StockAnalysis.com real-time quote', 3196.3);
  const r = await rejectPrice(uid, { instrumentId: iid, asOf: '2026-11-12T07:00:00Z', source: 'StockAnalysis.com real-time quote', reason: 'wrong security' }, { db: a });
  assert.equal(r.nowUsing.price, 17.99);
  const [latest] = await a.query(`SELECT price::float8 AS price FROM wealth_v_latest_prices WHERE instrument_id=$1`, [iid]);
  assert.equal(latest.price, 17.99);
  const [kept] = await a.query(`SELECT price::float8 AS price, rejected_by, rejected_reason, rejected_at FROM wealth_instrument_prices WHERE instrument_id=$1 AND price=3196.3`, [iid]);
  assert.equal(kept.price, 3196.3);
  assert.equal(kept.rejected_by, 'owner');
  assert.equal(kept.rejected_reason, 'wrong security');
  assert.ok(kept.rejected_at);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_instrument_prices WHERE instrument_id=$1`, [iid]))[0].n, 2, 'nothing deleted');
  await assert.rejects(rejectPrice(uid, { instrumentId: iid, asOf: '2026-11-12T07:00:00Z', source: 'StockAnalysis.com real-time quote' }, { db: a }), e => e.status === 404);
  assert.deepEqual(await priceJumps(uid, { db: a }), [], 'no longer flagged');
});

test('reject needs an earlier price to fall back to', async () => {
  const { a, uid, iid, price } = await setup();
  await price('2026-11-12T07:00:00Z', 'Yahoo Finance', 3196.3);
  await assert.rejects(rejectPrice(uid, { instrumentId: iid, asOf: '2026-11-12T07:00:00Z', source: 'Yahoo Finance' }, { db: a }), e => e.status === 409);
});

test('change price: stores an owner correction as the latest price and rejects the row it replaces', async () => {
  const { a, uid, iid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 17.99);
  await price('2026-11-12T07:00:00Z', 'StockAnalysis.com real-time quote', 3196.3);
  const r = await changePrice(uid, { instrumentId: iid, price: 18.25, replaces: { asOf: '2026-11-12T07:00:00Z', source: 'StockAnalysis.com real-time quote' } }, { db: a, now: NOW });
  assert.equal(r.stored.source, 'Owner correction');
  const [latest] = await a.query(`SELECT price::float8 AS price, source FROM wealth_v_latest_prices WHERE instrument_id=$1`, [iid]);
  assert.deepEqual([latest.price, latest.source], [18.25, 'Owner correction']);
  assert.equal((await a.query(`SELECT count(*)::int n FROM wealth_instrument_prices WHERE instrument_id=$1 AND rejected_at IS NOT NULL`, [iid]))[0].n, 1);
  await assert.rejects(changePrice(uid, { instrumentId: iid, price: -3 }, { db: a }), e => e.status === 400);
  await assert.rejects(changePrice(uid, { instrumentId: iid, price: 'abc' }, { db: a }), e => e.status === 400);
});

test('change price on a USD instrument keeps the last good USD→INR rate, and refuses when none is stored', async () => {
  const { a, uid, iid, price } = await setup({ usd: true });
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 190, 88.5);
  const r = await changePrice(uid, { instrumentId: iid, price: 191 }, { db: a, now: NOW });
  assert.equal(r.stored.fx_to_inr, 88.5);
  const none = await setup({ usd: true });
  await none.price('2026-11-11T10:00:00Z', 'Yahoo Finance', 190, null);
  await assert.rejects(changePrice(none.uid, { instrumentId: none.iid, price: 191 }, { db: none.a }), e => e.status === 409);
});

test('Data quality lists the jump as an issue with the severity, and a rejected price drops out of it', async () => {
  const { a, uid, iid, price } = await setup();
  await price('2026-11-11T10:00:00Z', 'Yahoo Finance', 17.99);
  await price('2026-11-12T07:00:00Z', 'StockAnalysis.com real-time quote', 3196.3);
  const dq = await collectIssues(uid, { db: a, now: NOW, env: {} });
  const issue = dq.issues.find(i => i.category === 'price_jump');
  assert.ok(issue, 'price_jump issue present');
  assert.equal(issue.severity, 'high');
  assert.match(issue.message, /TATSILV/);
  assert.equal(issue.evidence.latest.price, 3196.3);
  await rejectPrice(uid, { instrumentId: iid, asOf: '2026-11-12T07:00:00Z', source: 'StockAnalysis.com real-time quote' }, { db: a });
  const after = await collectIssues(uid, { db: a, now: NOW, env: {} });
  assert.equal(after.issues.filter(i => i.category === 'price_jump').length, 0);
});

test('the view that every page reads skips rejected rows; the migration is additive (no row deleted)', () => {
  const sqlText = readFileSync(new URL('../migrations/0025_price_review.sql', import.meta.url), 'utf8');
  assert.match(sqlText, /ADD COLUMN IF NOT EXISTS rejected_at/);
  assert.match(sqlText, /WHERE rejected_at IS NULL/);
  assert.doesNotMatch(sqlText, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
});

test('UI: red and yellow badges, Reject (use old price) and Change price buttons on the Data quality page', () => {
  const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  assert.match(app, /i\.category==='price_jump'\?priceJumpRowHtml\(i\)/);
  assert.match(app, /Reject — use old price/);
  assert.match(app, /data-pj-change/);
  assert.match(app, /reject_price/);
  assert.match(app, /change_price/);
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.pj-badge\.pj-high\{color:#ff8f96/);
  assert.match(css, /\.pj-badge\.pj-medium\{color:#f5c26b/);
});
