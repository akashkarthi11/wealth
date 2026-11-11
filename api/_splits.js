// Account splits (migration 0019): pots inside one account, e.g. Atom → Invest later, Rent, Emergency fund, Round ups.
// Balance of a split = its latest recorded balance + signed movements after it (+ in, − out), marked "estimated" when
// movements were added since. Splits never change the account balance or totals.
import { sql, withActor, httpError, isUuid } from './_lib.js';

const r2 = x => Math.round(x * 100) / 100;
const text = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);

export async function splitsForAccount(uid, accountId, { db = sql } = {}) {
  const splits = await db.query(`SELECT s.id, s.split_key, s.name, s.kind, s.goal_amount::float8 AS goal_amount, s.purpose, s.sort_order,
      b.balance::float8 AS base_balance, b.as_of AS base_as_of, b.status AS base_status
    FROM wealth_account_splits s
    LEFT JOIN LATERAL (SELECT balance, as_of, status FROM wealth_account_split_balances WHERE split_id = s.id ORDER BY as_of DESC LIMIT 1) b ON true
    WHERE s.user_id = $1 AND s.account_id = $2 AND s.status = 'active' ORDER BY s.sort_order, s.name`, [uid, accountId]);
  if (!splits.length) return [];
  const moves = await db.query(`SELECT m.id, m.split_id, m.occurred_at, m.amount::float8 AS amount, m.transaction_id, m.note
    FROM wealth_account_split_moves m WHERE m.split_id = ANY($1::uuid[]) ORDER BY m.occurred_at DESC`, [splits.map(s => s.id)]);
  const base = splits.map(s => {
    const mine = moves.filter(m => m.split_id === s.id);
    const after = mine.filter(m => !s.base_as_of || new Date(m.occurred_at) > new Date(s.base_as_of));
    return { s, mine, after, delta: r2(after.reduce((n, m) => n + m.amount, 0)) };
  });
  // Interest is earned by every split (e.g. Atom pays interest on each pot): each day's interest from the nightly task
  // (interest ledger, accrual days on or after the split's screenshot day) is shared across the splits by balance,
  // rounded to paise so the shares add up exactly to the day's interest. Nothing is stored — it is derived every time.
  const interest = await splitInterest(db, uid, accountId, base).catch(() => new Map());
  return base.map(({ s, mine, after, delta }) => {
    const earned = r2(interest.get(s.id) || 0);
    const balance = s.base_balance == null && !after.length ? null : r2((s.base_balance || 0) + delta + earned);
    return { id: s.id, key: s.split_key, name: s.name, kind: s.kind, goal: s.goal_amount, purpose: s.purpose,
      balance, status: after.length || earned ? 'estimated' : s.base_status || null, verifiedBalance: s.base_balance, verifiedAt: s.base_as_of,
      movedSince: delta, interestSince: earned, goalPct: s.goal_amount && balance != null ? r2(Math.min(100, balance / s.goal_amount * 100)) : null,
      recentMoves: mine.slice(0, 8).map(m => ({ at: m.occurred_at, amount: m.amount, note: m.note, transactionId: m.transaction_id })) };
  });
}

const istDay = t => new Date(new Date(t).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Share each accrual day's interest across the splits that existed (had a screenshot balance) by that day, weighted by
// their balance (screenshot + moves + interest already shared). Largest-remainder rounding keeps exact paise.
export async function splitInterest(db, uid, accountId, base) {
  const out = new Map();
  const dated = base.filter(b => b.s.base_as_of && b.s.base_balance != null);
  if (!dated.length) return out;
  const [acct] = await db.query(`SELECT account_key FROM wealth_accounts WHERE id = $1 AND user_id = $2`, [accountId, uid]);
  if (!acct) return out;
  const first = dated.map(b => istDay(b.s.base_as_of)).sort()[0];
  const days = await db.query(`SELECT accrual_date::text AS d, sum(interest_amount)::float8 AS amount FROM wealth_interest_ledger
    WHERE user_id = $1 AND account_key = $2 AND accrual_date >= $3::date GROUP BY 1 ORDER BY 1`, [uid, acct.account_key, first]);
  for (const { d, amount } of days) {
    const paise = Math.round(amount * 100);
    if (!paise) continue;
    const eligible = dated.filter(b => istDay(b.s.base_as_of) <= d).map(b => ({ id: b.s.id, w: Math.max(0, b.s.base_balance + b.delta + (out.get(b.s.id) || 0)) }));
    const total = eligible.reduce((n, e) => n + e.w, 0);
    if (!(total > 0)) continue;
    const parts = eligible.map(e => { const raw = paise * e.w / total; return { id: e.id, p: Math.floor(raw), frac: raw - Math.floor(raw) }; });
    let left = paise - parts.reduce((n, x) => n + x.p, 0);
    parts.sort((x, y) => y.frac - x.frac).forEach(x => { if (left > 0) { x.p++; left--; } });
    for (const x of parts) out.set(x.id, r2((out.get(x.id) || 0) + x.p / 100));
  }
  return out;
}

async function ownSplit(db, uid, splitId) {
  if (!isUuid(splitId)) throw httpError(400, 'splitId must be a uuid');
  const [s] = await db.query(`SELECT * FROM wealth_account_splits WHERE id = $1 AND user_id = $2`, [splitId, uid]);
  if (!s) throw httpError(404, 'Split not found');
  return s;
}
const when = (v, now) => { const d = v ? new Date(v) : new Date(now); if (!Number.isFinite(d.getTime()) || d.getTime() > now + 60e3) throw httpError(400, 'date must be a date-time, not in the future'); return d; };

// POST /api/splits/balances {splitId, balance, asOf?, status?, note?} — e.g. from the Atom screen.
export async function recordSplitBalance(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const s = await ownSplit(db, uid, b?.splitId);
  const balance = Number(b.balance);
  if (!Number.isFinite(balance) || balance < 0 || balance > 1e12) throw httpError(400, 'balance must be a number ≥ 0');
  const status = String(b.status || 'verified');
  if (!['verified', 'estimated'].includes(status)) throw httpError(400, 'status must be verified or estimated');
  const asOf = when(b.asOf, now);
  if (dryRun) return { dryRun, splitId: s.id, wouldStore: { balance: r2(balance), asOf: asOf.toISOString(), status } };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_account_split_balances (split_id, as_of, balance, status, note) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (split_id, as_of) DO NOTHING RETURNING id`, [s.id, asOf.toISOString(), r2(balance), status, text(b.note)]]]);
  return { stored: ins.length > 0, splitId: s.id };
}

// POST /api/splits/moves {splitId, amount (+ in / − out), occurredAt?, transactionId?, note?} — e.g. +18 round-up, −rent.
export async function recordSplitMove(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const s = await ownSplit(db, uid, b?.splitId);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e12) throw httpError(400, 'amount must be a non-zero number (+ into the split, − out of it)');
  const at = when(b.occurredAt, now);
  if (b.transactionId != null) {
    if (!isUuid(b.transactionId)) throw httpError(400, 'transactionId must be a uuid');
    const [t] = await db.query(`SELECT account_id FROM wealth_transactions WHERE id = $1 AND user_id = $2`, [b.transactionId, uid]);
    if (!t) throw httpError(404, 'Transaction not found');
    if (t.account_id && t.account_id !== s.account_id) throw httpError(400, 'The transaction is on another account than this split');
  }
  if (dryRun) return { dryRun, splitId: s.id };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_account_split_moves (split_id, occurred_at, amount, transaction_id, note)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (split_id, transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING RETURNING id`,
    [s.id, at.toISOString(), r2(amount), b.transactionId || null, text(b.note)]]]);
  return { stored: ins.length > 0, splitId: s.id, duplicate: ins.length === 0 };
}
