// Price review (owner, 2026-11-12): find a latest price that jumped far from the previous one, and let the owner reject it
// (the previous price is used again) or change it. Rejected rows are kept, never deleted (migration 0025).
import { sql, withActor, httpError, isUuid } from './_lib.js';

// Size of the jump between the latest price and the one before it. At or above MEDIUM_PCT → yellow, HIGH_PCT → red.
export const MEDIUM_PCT = 10;
export const HIGH_PCT = 30;

export function priceJumpSeverity(changePct) {
  const a = Math.abs(Number(changePct));
  if (!Number.isFinite(a)) return null;
  return a >= HIGH_PCT ? 'high' : a >= MEDIUM_PCT ? 'medium' : null;
}

const HELD = `EXISTS (SELECT 1 FROM wealth_holdings h JOIN wealth_accounts a ON a.id = h.account_id
  WHERE h.instrument_id = i.id AND h.status = 'active' AND a.user_id = $1)`;

// Latest price against the previous one, for every instrument this user holds.
export async function priceJumps(uid, { db = sql } = {}) {
  const rows = await db.query(`SELECT i.id AS instrument_id, i.symbol, trim(i.currency) AS currency,
      l.price::float8 AS latest_price, l.as_of AS latest_as_of, l.source AS latest_source,
      p.price::float8 AS prev_price, p.as_of AS prev_as_of, p.source AS prev_source
    FROM wealth_instruments i
    JOIN LATERAL (SELECT price, as_of, source FROM wealth_instrument_prices WHERE instrument_id = i.id AND rejected_at IS NULL
                  ORDER BY as_of DESC, fetched_at DESC LIMIT 1) l ON true
    JOIN LATERAL (SELECT price, as_of, source FROM wealth_instrument_prices WHERE instrument_id = i.id AND rejected_at IS NULL AND as_of < l.as_of
                  ORDER BY as_of DESC, fetched_at DESC LIMIT 1) p ON true
    WHERE ${HELD} AND p.price > 0`, [uid]);
  const out = [];
  for (const r of rows) {
    const changePct = (r.latest_price - r.prev_price) / r.prev_price * 100;
    const severity = priceJumpSeverity(changePct);
    if (!severity) continue;
    out.push({
      instrumentId: r.instrument_id, symbol: r.symbol, currency: r.currency, severity,
      changePct: Math.round(changePct * 10) / 10,
      latest: { price: r.latest_price, asOf: new Date(r.latest_as_of).toISOString(), source: r.latest_source },
      previous: { price: r.prev_price, asOf: new Date(r.prev_as_of).toISOString(), source: r.prev_source },
    });
  }
  return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

async function assertHeld(uid, instrumentId, db) {
  if (!isUuid(instrumentId)) throw httpError(400, 'instrumentId must be a uuid');
  const r = await db.query(`SELECT i.id, trim(i.currency) AS currency FROM wealth_instruments i WHERE i.id = $2 AND ${HELD}`, [uid, instrumentId]);
  if (!r.length) throw httpError(404, 'That instrument is not one of your holdings.');
  return r[0];
}

const isoOrThrow = v => { const t = Date.parse(v); if (!Number.isFinite(t)) throw httpError(400, 'asOf must be the quote time of the price row'); return new Date(t).toISOString(); };

// Reject one stored quote (identified by instrument + quote time + source). The previous price takes over.
export async function rejectPrice(uid, { instrumentId, asOf, source, reason } = {}, { db = sql, actor = 'owner' } = {}) {
  await assertHeld(uid, instrumentId, db);
  const when = isoOrThrow(asOf), src = String(source || '').trim();
  if (!src) throw httpError(400, 'source is required');
  const why = String(reason || '').trim().slice(0, 300) || 'Rejected by owner: price looked wrong';
  const row = (await db.query(`SELECT 1 FROM wealth_instrument_prices WHERE instrument_id=$1 AND as_of=$2 AND source=$3 AND rejected_at IS NULL`, [instrumentId, when, src]));
  if (!row.length) throw httpError(404, 'That price row was not found, or it is already rejected.');
  const fallback = await db.query(`SELECT price::float8 AS price, as_of, source FROM wealth_instrument_prices
    WHERE instrument_id=$1 AND rejected_at IS NULL AND NOT (as_of=$2 AND source=$3) ORDER BY as_of DESC, fetched_at DESC LIMIT 1`, [instrumentId, when, src]);
  if (!fallback.length) throw httpError(409, 'There is no earlier price to fall back to, so this price cannot be rejected. Use Change price instead.');
  await withActor(db, actor, [[`UPDATE wealth_instrument_prices SET rejected_at=now(), rejected_by=$4, rejected_reason=$5
    WHERE instrument_id=$1 AND as_of=$2 AND source=$3 AND rejected_at IS NULL`, [instrumentId, when, src, actor, why]]]);
  return { rejected: { instrumentId, asOf: when, source: src }, nowUsing: { price: fallback[0].price, asOf: new Date(fallback[0].as_of).toISOString(), source: fallback[0].source } };
}

// Replace a wrong price with one the owner types. Stored as a new quote at the current time (source 'Owner correction');
// the row it replaces, when given, is rejected with a reason. USD prices keep the last good USD→INR rate.
export async function changePrice(uid, { instrumentId, price, replaces, reason } = {}, { db = sql, actor = 'owner', now = Date.now() } = {}) {
  const inst = await assertHeld(uid, instrumentId, db);
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) throw httpError(400, 'price must be a number above zero');
  let fx = null;
  if (inst.currency === 'USD') {
    const f = await db.query(`SELECT fx_to_inr::float8 AS fx FROM wealth_instrument_prices WHERE instrument_id=$1 AND fx_to_inr > 0 AND rejected_at IS NULL ORDER BY as_of DESC LIMIT 1`, [instrumentId]);
    if (!f.length) throw httpError(409, 'No USD→INR rate is stored for this instrument, so a USD price cannot be changed here.');
    fx = f[0].fx;
  }
  const why = String(reason || '').trim().slice(0, 300) || 'Replaced by owner correction';
  const at = new Date(now).toISOString();
  const stmts = [[`INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr) VALUES ($1,$2,'Owner correction',$3,$4)
    ON CONFLICT (instrument_id, as_of, source) DO NOTHING`, [instrumentId, at, p, fx]]];
  if (replaces?.asOf && replaces?.source) {
    stmts.push([`UPDATE wealth_instrument_prices SET rejected_at=now(), rejected_by=$4, rejected_reason=$5
      WHERE instrument_id=$1 AND as_of=$2 AND source=$3 AND rejected_at IS NULL`, [instrumentId, isoOrThrow(replaces.asOf), String(replaces.source), actor, why]]);
  }
  await withActor(db, actor, stmts);
  return { stored: { instrumentId, asOf: at, source: 'Owner correction', price: p, fx_to_inr: fx }, replaced: !!(replaces?.asOf && replaces?.source) };
}
