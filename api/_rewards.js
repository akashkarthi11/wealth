// Rewards & points (TSD Claude Plan 4, Part A). Programs, an append-only balance history and events (migration 0014).
// ₹ value only when the program has a rate with a source; cashback paid as money is read from income transactions.
import { sql, withActor, httpError, isUuid, isDay } from './_lib.js';

const r2 = x => Math.round(x * 100) / 100;
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const text = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);
// Cashback / reward money that already arrived as income transactions (never stored twice).
const CASHBACK_CATEGORY = '(cashback|reward)';

export function rewardValue(program, units) {
  const rate = program.inr_per_unit == null ? null : Number(program.inr_per_unit);
  return rate == null || units == null ? null : r2(Number(units) * rate);
}

export async function rewardsOverview(uid, { db = sql, now = Date.now() } = {}) {
  const programs = await db.query(`SELECT p.id, p.program_key, p.provider, p.name, p.unit, p.account_id, p.inr_per_unit::float8 AS inr_per_unit,
      p.rate_source, p.rate_as_of::text AS rate_as_of, p.min_redeem::float8 AS min_redeem, p.redeem_note, p.expiry_note, p.status, p.cash_match, p.scheme, p.cash_any_account, a.account_type AS account_type, a.masked_identifier AS account_mask,
      a.bank_name AS account_bank, a.account_name AS account_name,
      b.units::float8 AS units, b.as_of, b.status AS balance_status, b.expires_on::text AS expires_on, b.note AS balance_note
    FROM wealth_reward_programs p
    LEFT JOIN wealth_accounts a ON a.id = p.account_id
    LEFT JOIN LATERAL (SELECT units, as_of, status, expires_on, note FROM wealth_reward_balances WHERE program_id = p.id ORDER BY as_of DESC LIMIT 1) b ON true
    WHERE p.user_id = $1 AND p.status = 'active' ORDER BY p.provider, p.name`, [uid]);
  const history = await db.query(`SELECT b.program_id, b.as_of, b.units::float8 AS units, b.status FROM wealth_reward_balances b
    JOIN wealth_reward_programs p ON p.id = b.program_id WHERE p.user_id = $1 AND b.as_of > now() - interval '400 days' ORDER BY b.as_of`, [uid]);
  const events = await db.query(`SELECT e.program_id, e.occurred_on::text AS occurred_on, e.kind, e.units::float8 AS units, e.inr_value::float8 AS inr_value, e.note
    FROM wealth_reward_events e JOIN wealth_reward_programs p ON p.id = e.program_id WHERE p.user_id = $1 ORDER BY e.occurred_on DESC LIMIT 50`, [uid]);
  const month = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 7), year = month.slice(0, 4);
  const [cash] = await db.query(`SELECT
      coalesce(sum(amount) FILTER (WHERE to_char(occurred_on,'YYYY-MM') = $2), 0)::float8 AS month,
      coalesce(sum(amount) FILTER (WHERE to_char(occurred_on,'YYYY') = $3), 0)::float8 AS year,
      coalesce(sum(amount), 0)::float8 AS all_time, count(*)::int AS count
    FROM wealth_transactions WHERE user_id = $1 AND kind = 'income' AND duplicate_of IS NULL AND category ~* '${CASHBACK_CATEGORY}'`, [uid, month, year])
    .catch(() => [{ month: 0, year: 0, all_time: 0, count: 0 }]);
  const byCategory = await db.query(`SELECT category, count(*)::int AS n, sum(amount)::float8 AS amount, max(occurred_on)::text AS last
    FROM wealth_transactions WHERE user_id = $1 AND kind = 'income' AND duplicate_of IS NULL AND category ~* '${CASHBACK_CATEGORY}'
    GROUP BY category ORDER BY sum(amount) DESC`, [uid]).catch(() => []);
  // Programs paid as money (cash_match): earned = matching income transactions (optionally on the linked account).
  const cashEarned = new Map();
  for (const p of programs.filter(x => x.cash_match)) {
    const [c] = await db.query(`SELECT coalesce(sum(amount) FILTER (WHERE to_char(occurred_on,'YYYY-MM') = $3), 0)::float8 AS month,
        coalesce(sum(amount) FILTER (WHERE to_char(occurred_on,'YYYY') = $4), 0)::float8 AS year, coalesce(sum(amount), 0)::float8 AS all_time,
        count(*)::int AS count, max(occurred_on)::text AS last
      FROM wealth_transactions WHERE user_id = $1 AND kind = 'income' AND duplicate_of IS NULL
        AND (coalesce(category,'') || ' ' || coalesce(description,'')) ~* $2 AND ($5::uuid IS NULL OR $6 OR account_id = $5)`,
      [uid, p.cash_match, month, year, p.account_id, !!p.cash_any_account]).catch(() => [null]);
    if (c) cashEarned.set(p.id, c);
  }
  // Spend-based schemes (0016): units earned ≈ spend × rate ÷ ₹ per unit; tiers raise the rate at a unit balance.
  // scheme: {basis:"spend", rate, spend_bank?, spend_scope?: "bank"|"account", merchant?: regex, label?, tiers:[{at, rate, label}]}
  //  - spend_scope "account": only spends on the program's linked account (e.g. Swiggy on the HDFC Swiggy card).
  //  - merchant: only spends whose category/description match (e.g. "swiggy").
  //  - spend_account_type: only that kind of account at the bank (e.g. "credit_card": Slice Monies come from card spends only).
  //  - cash programs (no ₹ rate per unit) earn ₹ directly: 1 unit = ₹1.
  const schemeInfo = new Map();
  for (const p of programs.filter(x => x.scheme && x.scheme.basis === 'spend')) {
    const s = p.scheme, baseRate = Number(s.rate), perUnit = p.inr_per_unit == null ? 1 : Number(p.inr_per_unit), cashProgram = p.inr_per_unit == null;
    if (!(baseRate > 0) || !(perUnit > 0)) continue;
    const byAccount = s.spend_scope === 'account' && p.account_id, merchant = s.merchant ? String(s.merchant) : null;
    const [sp] = await db.query(`SELECT coalesce(sum(t.amount) FILTER (WHERE to_char(t.occurred_on,'YYYY-MM') = $3), 0)::float8 AS month,
        coalesce(sum(t.amount) FILTER (WHERE t.occurred_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 90), 0)::float8 AS last90,
        coalesce(sum(t.amount) FILTER (WHERE $7::timestamptz IS NOT NULL AND t.occurred_on > ($7::timestamptz AT TIME ZONE 'Asia/Kolkata')::date), 0)::float8 AS sinceBalance
      FROM wealth_transactions t JOIN wealth_accounts a ON a.id = t.account_id
      WHERE t.user_id = $1 AND t.duplicate_of IS NULL
        AND (t.kind = 'expense' OR (t.kind = 'investment' AND a.account_type = 'credit_card'))  -- a card purchase of gold etc. is a card spend too
        AND (CASE WHEN $4::uuid IS NOT NULL THEN t.account_id = $4 ELSE a.bank_name = $2 END)
        AND ($6::text IS NULL OR a.account_type = $6)
        AND ($5::text IS NULL OR (coalesce(t.category,'') || ' ' || coalesce(t.description,'')) ~* $5)`,
      [uid, String(s.spend_bank || p.provider), month, byAccount ? p.account_id : null, merchant, s.spend_account_type ? String(s.spend_account_type) : null, p.as_of || null]).catch(() => [null]);
    const tiers = (Array.isArray(s.tiers) ? s.tiers : []).filter(t => Number(t.at) > 0 && Number(t.rate) > 0).sort((x, y) => x.at - y.at);
    const reached = p.units == null ? [] : tiers.filter(t => p.units >= Number(t.at));
    const rate = reached.length ? Number(reached[reached.length - 1].rate) : baseRate;
    const next = p.units == null ? null : tiers.find(t => Number(t.at) > p.units) || null;
    const unitsPerRupee = rate / perUnit, avgMonth = sp ? r2(sp.last90 / 3) : null;
    const accruedSpend = sp ? r2(sp.sinceBalance || 0) : 0;
    const accruedUnits = p.as_of && !cashProgram ? r2(accruedSpend * unitsPerRupee) : 0;
    const effectiveUnits = p.units == null ? null : r2(p.units + accruedUnits);
    const toNext = next ? r2(Number(next.at) - (effectiveUnits ?? p.units)) : null;
    schemeInfo.set(p.id, { basis: 'spend', rate, baseRate, cash: cashProgram, spendBank: String(s.spend_bank || p.provider),
      accruedSpend, accruedUnits, effectiveUnits, effectiveValue: effectiveUnits == null ? null : rewardValue(p, effectiveUnits),
      accruedAsOf: p.as_of || null,
      spendLabel: String(s.label || (merchant ? merchant.charAt(0).toUpperCase() + merchant.slice(1) + ' orders' : (s.spend_bank || p.provider) + ' spends')), unitsPerRupee: r2(unitsPerRupee),
      tiers: [{ at: 0, rate: baseRate }].concat(tiers.map(t => ({ at: Number(t.at), rate: Number(t.rate), label: t.label || null }))),
      next: next ? { at: Number(next.at), rate: Number(next.rate), label: next.label || 'Next tier' } : null,
      progressPct: next && effectiveUnits != null ? r2(effectiveUnits / Number(next.at) * 100) : null, toNext, toNextSpend: toNext == null ? null : r2(toNext / unitsPerRupee),
      monthSpend: sp ? r2(sp.month) : null, monthUnitsEst: sp ? r2(sp.month * unitsPerRupee) : null, avgMonthlySpend: avgMonth,
      monthsToNext: toNext != null && avgMonth > 0 ? Math.ceil(toNext / (avgMonth * unitsPerRupee)) : null });
  }
  const list = programs.map(p => {
    const si = schemeInfo.get(p.id) || null, effectiveUnits = si?.effectiveUnits ?? p.units;
    return { ...p, recordedUnits: p.units, units: effectiveUnits, schemeInfo: si, cashEarned: cashEarned.get(p.id) || null,
      value: si?.effectiveValue ?? rewardValue(p, p.units),
    toRedeem: p.min_redeem && effectiveUnits != null ? Math.max(0, r2(p.min_redeem - effectiveUnits)) : null,
    history: history.filter(h => h.program_id === p.id).map(h => ({ asOf: h.as_of, units: h.units, status: h.status })),
    events: events.filter(e => e.program_id === p.id).slice(0, 10) };
  });
  const valued = list.filter(p => p.value != null);
  return { month, programs: list, totals: { value: r2(valued.reduce((n, p) => n + p.value, 0)), valuedPrograms: valued.length, unvaluedPrograms: list.length - valued.length },
    cashback: { ...cash, categories: byCategory } };
}

async function ownProgram(db, uid, programId) {
  if (!isUuid(programId)) throw httpError(400, 'programId must be a uuid');
  const [p] = await db.query(`SELECT * FROM wealth_reward_programs WHERE id = $1 AND user_id = $2`, [programId, uid]);
  if (!p) throw httpError(404, 'Program not found');
  return p;
}

// POST /api/rewards/balances {programId, units, asOf?, status?, expiresOn?, note?}
export async function recordRewardBalance(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const p = await ownProgram(db, uid, b?.programId);
  const units = num(b.units);
  if (!Number.isFinite(units) || units < 0 || units > 1e12) throw httpError(400, 'units must be a number ≥ 0');
  const asOf = b.asOf ? new Date(b.asOf) : new Date(now);
  if (!Number.isFinite(asOf.getTime()) || asOf.getTime() > now + 60e3) throw httpError(400, 'asOf must be a date-time, not in the future');
  const status = String(b.status || 'verified');
  if (!['verified', 'estimated'].includes(status)) throw httpError(400, 'status must be verified (screenshot / statement) or estimated');
  if (b.expiresOn != null && b.expiresOn !== '' && !isDay(b.expiresOn)) throw httpError(400, 'expiresOn must be YYYY-MM-DD');
  const row = { units: r2(units), asOf: asOf.toISOString(), status, value: rewardValue(p, units) };
  if (dryRun) return { dryRun, programId: p.id, wouldStore: row };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_reward_balances (program_id, as_of, units, status, expires_on, note)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (program_id, as_of) DO NOTHING RETURNING id`,
    [p.id, row.asOf, row.units, status, b.expiresOn || null, text(b.note)]]]);
  return { stored: ins.length > 0, programId: p.id, ...row };
}

// POST /api/rewards/events {programId, occurredOn, kind, units, inrValue?, transactionId?, note?}
export async function recordRewardEvent(uid, b, { db = sql, actor = 'owner', dryRun = false } = {}) {
  const p = await ownProgram(db, uid, b?.programId);
  if (!isDay(b.occurredOn)) throw httpError(400, 'occurredOn must be YYYY-MM-DD');
  if (!['earned', 'redeemed', 'expired', 'adjusted'].includes(b.kind)) throw httpError(400, 'kind must be earned, redeemed, expired or adjusted');
  const units = num(b.units); if (!Number.isFinite(units) || Math.abs(units) > 1e12) throw httpError(400, 'units must be a number');
  const inr = b.inrValue == null || b.inrValue === '' ? null : num(b.inrValue);
  if (inr !== null && !Number.isFinite(inr)) throw httpError(400, 'inrValue must be a number');
  if (b.transactionId != null && !isUuid(b.transactionId)) throw httpError(400, 'transactionId must be a uuid');
  if (dryRun) return { dryRun, programId: p.id };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_reward_events (program_id, occurred_on, kind, units, inr_value, transaction_id, note)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $6::uuid IS NULL OR EXISTS (SELECT 1 FROM wealth_transactions WHERE id = $6 AND user_id = $8) RETURNING id`,
    [p.id, b.occurredOn, b.kind, r2(units), inr === null ? null : r2(inr), b.transactionId || null, text(b.note), uid]]]);
  if (!ins.length) throw httpError(404, 'Transaction not found');
  return { stored: true, id: ins[0].id };
}

// POST /api/rewards/programs {programKey?|programId?, provider, name, unit, inrPerUnit?, rateSource?, rateAsOf?, minRedeem?, redeemNote?, expiryNote?, accountId?}
// Creates a program or updates its rate / redemption details. A ₹ rate needs its source.
export async function upsertRewardProgram(uid, b, { db = sql, actor = 'owner', dryRun = false } = {}) {
  const rate = b.inrPerUnit == null || b.inrPerUnit === '' ? null : num(b.inrPerUnit);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1e6)) throw httpError(400, 'inrPerUnit must be a number ≥ 0');
  if (rate !== null && !text(b.rateSource)) throw httpError(400, 'rateSource is required with inrPerUnit (e.g. "Slice redeem screen, 11 Nov 2026")');
  if (b.rateAsOf != null && b.rateAsOf !== '' && !isDay(b.rateAsOf)) throw httpError(400, 'rateAsOf must be YYYY-MM-DD');
  const min = b.minRedeem == null || b.minRedeem === '' ? null : num(b.minRedeem);
  if (min !== null && (!Number.isFinite(min) || min < 0)) throw httpError(400, 'minRedeem must be a number ≥ 0');
  if (b.accountId != null && !isUuid(b.accountId)) throw httpError(400, 'accountId must be a uuid');
  const fields = [rate, text(b.rateSource), b.rateAsOf || null, min, text(b.redeemNote), text(b.expiryNote)];
  if (b.programId) {
    const p = await ownProgram(db, uid, b.programId);
    if (dryRun) return { dryRun, programId: p.id };
    if (b.accountId) { const [own] = await db.query(`SELECT 1 FROM wealth_accounts WHERE id = $1 AND user_id = $2`, [b.accountId, uid]); if (!own) throw httpError(404, 'Account not found'); }
    await withActor(db, actor, [[`UPDATE wealth_reward_programs SET account_id = coalesce($8::uuid, account_id), inr_per_unit = coalesce($2, inr_per_unit), rate_source = coalesce($3, rate_source),
      rate_as_of = coalesce($4::date, rate_as_of), min_redeem = coalesce($5, min_redeem), redeem_note = coalesce($6, redeem_note),
      expiry_note = coalesce($7, expiry_note), updated_at = now() WHERE id = $1`, [p.id, ...fields, b.accountId || null]]]);
    return { stored: true, programId: p.id };
  }
  const key = String(b.programKey || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(key)) throw httpError(400, 'programKey: lowercase letters, digits and dashes');
  for (const f of ['provider', 'name', 'unit']) if (!text(b[f], 80)) throw httpError(400, f + ' is required');
  if (dryRun) return { dryRun, programKey: key };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_reward_programs (user_id, program_key, provider, name, unit, account_id,
      inr_per_unit, rate_source, rate_as_of, min_redeem, redeem_note, expiry_note)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE $6::uuid IS NULL OR EXISTS (SELECT 1 FROM wealth_accounts WHERE id = $6 AND user_id = $1)
    ON CONFLICT (user_id, program_key) DO NOTHING RETURNING id`, [uid, key, text(b.provider, 80), text(b.name, 80), text(b.unit, 40), b.accountId || null, ...fields]]]);
  if (!ins.length) throw httpError(409, 'A program with this key already exists (or the account is not yours)');
  return { stored: true, programId: ins[0].id };
}
