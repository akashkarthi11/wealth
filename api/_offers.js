import { sql, withActor, isUuid, isDay, httpError } from './_lib.js';

// Account offers and what they earn (0030 + 0031, owner 2026-11-14).
//
// An offer belongs to an account or card and says WHEN it applies, WHAT it gives, HOW OFTEN, and how it is applied:
//   when      payee words, paid by UPI / on a credit-card account, minimum and maximum payment, weekdays, valid dates, coupon code
//   what      percent of the payment, a flat amount, or an amount per block of rupees ("4 points per ₹150"); a cap per payment;
//             reward = cashback / discount / coupon (money) or points / coins / monies (a reward program's units)
//   how often unlimited, one time, or N times in total; and per day / week / month / billing cycle / year: uses and/or an amount
//   applied   automatically when a payment is accepted, or "ask me" (an offer that must be activated first, e.g. a Slice Spark)
//   exclusive offers in the same group on one account: only the best one applies (e.g. 10% Swiggy / 5% online / 1% everything)
//
// When a payment is accepted the matching offers are applied: each writes one row in wealth_offer_uses (the earning) with status
// 'expected'. Cashback is never written to the ledger as income here - the real credit is imported later and linked to the earning
// (status 'received'), so the same money is never counted twice. Points are counted on the Rewards page as earned since the last
// balance. A removed earning is marked 'cancelled' (kept, not deleted) and no longer counts toward any limit.
export const REWARD_UNITS = ['cashback', 'points', 'coins', 'monies', 'coupon', 'discount'];
export const CASH_UNITS = ['cashback', 'discount', 'coupon'];
export const FREQUENCIES = ['unlimited', 'one_time', 'limited'];
export const PERIODS = ['none', 'day', 'week', 'month', 'cycle', 'year'];
export const PAYMENT_MODES = ['any', 'upi', 'card'];
export const BENEFIT_TYPES = ['percent', 'flat', 'per_block'];
export const APPLY_MODES = ['auto', 'ask'];
export const isCashUnit = u => CASH_UNITS.includes(u);
export const kindOf = unit => (unit === 'cashback' ? 'cashback' : unit === 'discount' ? 'discount' : unit === 'coupon' ? 'coupon' : 'points');

const r2 = n => Math.round(n * 100) / 100;
const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const numOrNull = v => (v === '' || v == null ? null : Number(v));
const intOrNull = v => (v === '' || v == null ? null : Number(v));

export function normMerchants(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  return [...new Set(list.map(x => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 10);
}
const normWeekdays = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim()).filter(x => x !== '').map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort();

// ---- the arithmetic -------------------------------------------------------------------------------------------------------
// What an offer gives on one payment of `amount`, before any limit of a period. Money offers give ₹; points offers give units.
//   percent   cash: amount x value%.   points: amount x value% is a ₹ value, turned into units with the program's ₹ per unit
//   flat      the value (₹ or units)
//   per_block floor(amount / block) x value  ("4 points per ₹150": a ₹400 payment earns 2 blocks = 8 points)
// then cut at max_benefit (same unit). Returns null when it cannot be worked out (percent of points without a program rate).
export function computeEarning(o, amount, program = null) {
  const a = Number(amount), v = Number(o.benefit_value), cash = isCashUnit(o.reward_unit);
  const cap = o.max_benefit == null ? null : Number(o.max_benefit);
  const rate = program && program.inr_per_unit != null ? Number(program.inr_per_unit) : null;
  let raw;
  if (o.benefit_type === 'per_block') raw = Math.floor(a / Number(o.block_amount)) * v;
  else if (o.benefit_type === 'flat') raw = v;
  else if (cash) raw = a * v / 100;
  else { if (!(rate > 0)) return null; raw = (a * v / 100) / rate; }
  const amt = r2(cap != null ? Math.min(raw, cap) : raw);
  return shapeEarning(o, amt, a, rate);
}
function shapeEarning(o, amt, a, rate) {
  const cash = isCashUnit(o.reward_unit), inr = cash ? amt : rate > 0 ? r2(amt * rate) : null;
  const percent = o.benefit_type === 'percent' ? Number(o.benefit_value) : a > 0 && inr != null ? r2(inr / a * 100) : null;
  return { kind: kindOf(o.reward_unit), unit: o.reward_unit, amount: amt, units: cash ? null : amt, inr, percent };
}
// Kept for callers that only want the money figure of a money offer.
export function offerBenefit(o, amount) { const e = computeEarning(o, amount, null); return e ? e.amount : 0; }

// ---- periods and limits ---------------------------------------------------------------------------------------------------
const dayMs = 864e5;
const toDay = ms => new Date(ms).toISOString().slice(0, 10);
const fromDay = d => Date.parse(d + 'T00:00:00Z');
const addMonths = (d, n) => { const t = new Date(fromDay(d)); return toDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, t.getUTCDate())); };

// The period [start, end) that holds `day` (YYYY-MM-DD): calendar day / week (Monday start) / month / year, or a billing cycle
// that starts on `cycleDay` of the month.
export function periodWindow(period, cycleDay, day) {
  const t = new Date(fromDay(day));
  if (period === 'day') return [day, toDay(fromDay(day) + dayMs)];
  if (period === 'week') { const start = fromDay(day) - ((t.getUTCDay() + 6) % 7) * dayMs; return [toDay(start), toDay(start + 7 * dayMs)]; }
  if (period === 'month') return [toDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)), toDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))];
  if (period === 'year') return [toDay(Date.UTC(t.getUTCFullYear(), 0, 1)), toDay(Date.UTC(t.getUTCFullYear() + 1, 0, 1))];
  if (period === 'cycle') {
    const c = Math.min(Math.max(Number(cycleDay) || 1, 1), 28);
    const thisStart = toDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), c));
    const start = day >= thisStart ? thisStart : addMonths(thisStart, -1);
    return [start, addMonths(start, 1)];
  }
  return null;
}

// The amount a recorded use took from the offer's limits, in the offer's own unit (₹ for money offers, units for points).
const usedAmount = (o, u) => (isCashUnit(o.reward_unit) ? Number(u.benefit) : Number(u.units ?? u.benefit));

// Where does this offer stand for a payment on `day`, given the uses recorded so far (cancelled ones are not passed in)?
export function offerStanding(o, uses, day) {
  const mine = uses.filter(u => u.offer_id === o.id);
  const totalCap = o.frequency === 'one_time' ? 1 : o.frequency === 'limited' ? Number(o.max_uses) : null;
  const win = o.period && o.period !== 'none' ? periodWindow(o.period, o.cycle_day, day) : null;
  const inWin = win ? mine.filter(u => String(u.used_on).slice(0, 10) >= win[0] && String(u.used_on).slice(0, 10) < win[1]) : [];
  const periodUses = inWin.length, periodBenefit = r2(inWin.reduce((s, u) => s + usedAmount(o, u), 0));
  const usesLeftTotal = totalCap == null ? null : Math.max(totalCap - mine.length, 0);
  const usesLeftPeriod = win && o.period_max_uses != null ? Math.max(Number(o.period_max_uses) - periodUses, 0) : null;
  const benefitLeftPeriod = win && o.period_max_benefit != null ? r2(Math.max(Number(o.period_max_benefit) - periodBenefit, 0)) : null;
  const exhausted = usesLeftTotal === 0 ? 'used up' : usesLeftPeriod === 0 ? 'period limit reached' : benefitLeftPeriod === 0 ? 'period benefit limit reached' : null;
  return { usedTotal: mine.length, usesLeftTotal, periodUses, periodBenefit, usesLeftPeriod, benefitLeftPeriod, window: win, exhausted };
}

// ---- matching -------------------------------------------------------------------------------------------------------------
// Does the offer apply to this payment? tx: {account_id, kind, category, description, amount, occurred_on, subtype_code}.
// Same account, on, inside its dates and weekdays, between the minimum and maximum payment, spending (not a repayment), paid the way
// the offer asks, the payee contains a payee word (none = any payee), and no limit is used up.
export function offerMatches(o, tx, uses = []) {
  if (!o.active || o.account_id !== tx.account_id) return false;
  const day = String(tx.occurred_on).slice(0, 10);
  if (o.valid_from && day < String(o.valid_from).slice(0, 10)) return false;
  if (o.valid_to && day > String(o.valid_to).slice(0, 10)) return false;
  if (o.weekdays?.length && !o.weekdays.includes(new Date(fromDay(day)).getUTCDay())) return false;
  if (o.min_spend != null && Number(tx.amount) < Number(o.min_spend)) return false;
  if (o.max_spend != null && Number(tx.amount) > Number(o.max_spend)) return false;
  if (!['expense', 'investment'].includes(tx.kind)) return false;     // repayments and EMIs (liability) are not spending
  const hay = `${tx.description || ''} ${tx.category || ''}`.toLowerCase();
  if (o.payment_mode === 'upi' && !/\bupi\b/.test(hay)) return false;
  if (o.payment_mode === 'card' && tx.subtype_code !== 'credit_card') return false;
  const words = o.merchants || [];
  if (words.length && !words.some(w => hay.includes(w))) return false;
  return !offerStanding(o, uses, day).exhausted;
}

// The offers that match a payment, each with what it gives. `programs` is a Map(id -> {inr_per_unit, name, unit}) (for points).
// Offers of one exclusive group: only the best (largest ₹ value, else largest amount) is applicable; the others carry `shadowed`.
export function matchOffers(offers, tx, uses = [], programs = new Map()) {
  const day = String(tx.occurred_on).slice(0, 10);
  const out = [];
  for (const o of offers) {
    if (!offerMatches(o, tx, uses)) continue;
    const program = o.program_id ? programs.get(o.program_id) || null : null;
    const st = offerStanding(o, uses, day);
    let e = computeEarning(o, tx.amount, program);
    if (!e) continue;
    if (st.benefitLeftPeriod != null && e.amount > st.benefitLeftPeriod) {
      const rate = program && program.inr_per_unit != null ? Number(program.inr_per_unit) : null;
      e = shapeEarning(o, st.benefitLeftPeriod, Number(tx.amount), rate);
    }
    if (!(e.amount > 0)) continue;
    out.push({
      id: o.id, title: o.title, kind: e.kind, unit: e.unit, rewardUnit: o.reward_unit, amount: e.amount, units: e.units, inr: e.inr, percent: e.percent,
      benefitType: o.benefit_type, benefitValue: Number(o.benefit_value), maxBenefit: o.max_benefit == null ? null : Number(o.max_benefit),
      expected: e.amount, couponCode: o.coupon_code || null, verifyStatus: o.verify_status, notes: o.notes || null, apply: o.apply_mode || 'auto',
      programId: o.program_id || null, programName: program ? program.name : null, programUnit: program ? program.unit : null, group: o.exclusive_group || null, oneTime: o.frequency === 'one_time',
      usesLeftTotal: st.usesLeftTotal, usesLeftPeriod: st.usesLeftPeriod, benefitLeftPeriod: st.benefitLeftPeriod, shadowed: null,
    });
  }
  // Only the automatic offers of a group compete: an "ask me" offer (not applied unless switched on) never hides the automatic one.
  // When the owner switches an "ask me" offer on, applyOffers keeps only the best of the group (see bestPerGroup).
  const best = new Map();
  for (const m of out) if (m.group && m.apply === 'auto' && (!best.has(m.group) || worth(m) > worth(best.get(m.group)))) best.set(m.group, m);
  for (const m of out) if (m.group && m.apply === 'auto' && best.get(m.group) !== m) m.shadowed = best.get(m.group).title;
  return out.sort((a, b) => (a.shadowed ? 1 : 0) - (b.shadowed ? 1 : 0) || worth(b) - worth(a));
}
const worth = m => (m.inr != null ? m.inr : m.amount);
// Of the offers to apply, one per exclusive group: the best (a group is "only the best applies").
function bestPerGroup(list) {
  const keep = new Map();
  for (const m of list) if (m.group && (!keep.has(m.group) || worth(m) > worth(keep.get(m.group)))) keep.set(m.group, m);
  return list.filter(m => !m.group || keep.get(m.group) === m);
}

// ---- reading --------------------------------------------------------------------------------------------------------------
const COLS = `o.id, o.account_id, o.title, o.merchants, o.payment_mode, o.weekdays, o.coupon_code, o.benefit_type, o.benefit_value::float8 AS benefit_value,
  o.block_amount::float8 AS block_amount, o.max_benefit::float8 AS max_benefit, o.min_spend::float8 AS min_spend, o.max_spend::float8 AS max_spend, o.reward_unit,
  o.frequency, o.max_uses, o.period, o.cycle_day, o.period_max_uses, o.period_max_benefit::float8 AS period_max_benefit, o.valid_from::text AS valid_from,
  o.valid_to::text AS valid_to, o.active, o.verify_status, o.source_url, o.notes, o.last_checked_on::text AS last_checked_on, o.program_id, o.apply_mode,
  o.exclusive_group, o.preset`;

export async function programsFor(uid, { db = sql } = {}) {
  const rows = await db.query(`SELECT id, name, provider, unit, account_id, inr_per_unit::float8 AS inr_per_unit FROM wealth_reward_programs WHERE user_id=$1 AND status='active' ORDER BY provider, name`, [uid]);
  return rows;
}

// Recorded uses that still count toward limits (cancelled ones do not).
export async function usesFor(uid, offerIds, { db = sql } = {}) {
  if (!offerIds.length) return [];
  return db.query(`SELECT offer_id, used_on::text AS used_on, benefit::float8 AS benefit, units::float8 AS units, transaction_id FROM wealth_offer_uses
    WHERE user_id=$1 AND status <> 'cancelled' AND offer_id = ANY($2::uuid[])`, [uid, offerIds]);
}

export async function activeOffersFor(uid, accountIds, { db = sql } = {}) {
  if (!accountIds.length) return { offers: [], uses: [], programs: new Map() };
  const offers = await db.query(`SELECT ${COLS} FROM wealth_account_offers o WHERE o.user_id=$1 AND o.active AND o.account_id = ANY($2::uuid[])`, [uid, accountIds]);
  const [uses, programs] = await Promise.all([usesFor(uid, offers.map(o => o.id), { db }), programsFor(uid, { db })]);
  return { offers, uses, programs: new Map(programs.map(p => [p.id, p])) };
}

export async function listOffers(uid, { db = sql, today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) } = {}) {
  const [offers, accounts, programs] = await Promise.all([
    db.query(`SELECT ${COLS}, a.bank_name, a.account_name, a.masked_identifier, a.subtype_code,
        (SELECT count(*)::int FROM wealth_offer_uses u WHERE u.offer_id=o.id AND u.status <> 'cancelled') AS uses_count,
        (SELECT coalesce(sum(u.benefit) FILTER (WHERE u.kind <> 'points'), 0)::float8 FROM wealth_offer_uses u WHERE u.offer_id=o.id AND u.status <> 'cancelled') AS earned_money,
        (SELECT coalesce(sum(u.units), 0)::float8 FROM wealth_offer_uses u WHERE u.offer_id=o.id AND u.status <> 'cancelled' AND u.kind = 'points') AS earned_units
      FROM wealth_account_offers o JOIN wealth_accounts a ON a.id=o.account_id WHERE o.user_id=$1 ORDER BY a.bank_name, a.account_name, o.active DESC, o.title`, [uid]),
    db.query(`SELECT id, bank_name, account_name, masked_identifier, subtype_code FROM wealth_accounts WHERE user_id=$1 AND status='active' ORDER BY bank_name, account_name`, [uid]),
    programsFor(uid, { db }),
  ]);
  const uses = await usesFor(uid, offers.map(o => o.id), { db });
  return {
    offers: offers.map(o => ({ ...o, standing: offerStanding(o, uses, today), benefitTotal: r2(o.earned_money) })),
    accounts, programs,
    rewardUnits: REWARD_UNITS, frequencies: FREQUENCIES, periods: PERIODS, paymentModes: PAYMENT_MODES,
  };
}

// ---- writing offers -------------------------------------------------------------------------------------------------------
export async function saveOffer(uid, b, { db = sql } = {}) {
  if (!isUuid(b?.accountId)) throw httpError(400, 'Choose the account or card this offer belongs to.');
  const [acc] = await db.query('SELECT id FROM wealth_accounts WHERE id=$1 AND user_id=$2', [b.accountId, uid]);
  if (!acc) throw httpError(404, 'Account not found');
  const title = text(b.title, 120); if (!title) throw httpError(400, 'Give the offer a title.');
  const type = String(b.benefitType || ''); if (!BENEFIT_TYPES.includes(type)) throw httpError(400, 'Benefit must be a percent, a flat amount or an amount per block of rupees.');
  const unit = String(b.rewardUnit || 'cashback'); if (!REWARD_UNITS.includes(unit)) throw httpError(400, 'Reward must be one of ' + REWARD_UNITS.join(', '));
  const value = Number(b.benefitValue);
  if (!(value > 0) || (type === 'percent' && value > 100) || value > 1e7) throw httpError(400, type === 'percent' ? 'Percent must be above 0 and at most 100.' : 'The amount must be above 0.');
  let block = numOrNull(b.blockAmount);
  if (type === 'per_block') { if (!(block > 0) || block > 1e9) throw httpError(400, 'Give the block of rupees (for example 150 for "4 points per ₹150").'); } else block = null;
  const max = numOrNull(b.maxBenefit); if (max != null && !(max > 0 && max <= 1e9)) throw httpError(400, 'Maximum benefit must be above 0.');
  const min = numOrNull(b.minSpend); if (min != null && !(min >= 0 && min <= 1e12)) throw httpError(400, 'Minimum payment must be 0 or more.');
  const maxSpend = numOrNull(b.maxSpend); if (maxSpend != null && !(maxSpend > 0 && maxSpend <= 1e12)) throw httpError(400, 'Maximum payment must be above 0.');
  if (min != null && maxSpend != null && maxSpend < min) throw httpError(400, 'The maximum payment is below the minimum payment.');
  const mode = String(b.paymentMode || 'any'); if (!PAYMENT_MODES.includes(mode)) throw httpError(400, 'Payment way must be any, upi or card.');
  const apply = String(b.applyMode || 'auto'); if (!APPLY_MODES.includes(apply)) throw httpError(400, 'Apply must be auto or ask.');
  const frequency = String(b.frequency || 'unlimited'); if (!FREQUENCIES.includes(frequency)) throw httpError(400, 'How often must be unlimited, one_time or limited.');
  let maxUses = intOrNull(b.maxUses);
  if (frequency === 'limited') { if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) throw httpError(400, 'Give the total number of uses (1 or more).'); } else maxUses = null;
  const period = String(b.period || 'none'); if (!PERIODS.includes(period)) throw httpError(400, 'Period must be none, day, week, month, cycle or year.');
  let periodUses = intOrNull(b.periodMaxUses), periodBenefit = numOrNull(b.periodMaxBenefit), cycleDay = intOrNull(b.cycleDay);
  if (period === 'none') { periodUses = null; periodBenefit = null; cycleDay = null; }
  else {
    if (periodUses == null && periodBenefit == null) throw httpError(400, 'For a period limit, give the uses allowed or the maximum benefit in that period.');
    if (periodUses != null && (!Number.isInteger(periodUses) || periodUses < 1)) throw httpError(400, 'Uses per period must be a whole number, 1 or more.');
    if (periodBenefit != null && !(periodBenefit > 0 && periodBenefit <= 1e9)) throw httpError(400, 'Maximum benefit per period must be above 0.');
    if (period === 'cycle') { if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28) throw httpError(400, 'Billing cycle: give the statement day, 1 to 28.'); } else cycleDay = null;
  }
  let programId = b.programId || null;
  if (programId) {
    if (!isUuid(programId)) throw httpError(400, 'Invalid reward program.');
    const [p] = await db.query('SELECT id, inr_per_unit FROM wealth_reward_programs WHERE id=$1 AND user_id=$2', [programId, uid]);
    if (!p) throw httpError(404, 'Reward program not found');
    if (!isCashUnit(unit) && type === 'percent' && !(Number(p.inr_per_unit) > 0)) throw httpError(400, 'A percent of points needs the program\'s ₹ value per point. Use "per block of rupees" instead, or set the program\'s rate.');
  } else if (!isCashUnit(unit) && type === 'percent') throw httpError(400, 'Choose the reward program that receives these points (a percent of points needs its ₹ value per point).');
  const weekdays = normWeekdays(b.weekdays);
  if (Array.isArray(b.weekdays) && b.weekdays.length && !weekdays.length) throw httpError(400, 'Weekdays are 0 (Sunday) to 6 (Saturday).');
  const from = b.validFrom || null, to = b.validTo || null, checked = b.lastCheckedOn || null;
  for (const d of [from, to, checked]) if (d && !isDay(d)) throw httpError(400, 'Dates must be YYYY-MM-DD.');
  if (from && to && to < from) throw httpError(400, 'Valid to is before valid from.');
  const url = text(b.sourceUrl, 300); if (url && !/^https?:\/\//i.test(url)) throw httpError(400, 'Source link must start with http:// or https://');
  const verify = b.verifyStatus === 'verified' ? 'verified' : 'to_verify';
  const vals = [uid, b.accountId, title, normMerchants(b.merchants), type, value, max, min, unit, from, to, b.active === false ? false : true, verify, url, text(b.notes, 300), checked,
    mode, weekdays, text(b.couponCode, 40), frequency, maxUses, period, cycleDay, periodUses, periodBenefit,
    maxSpend, block, programId, apply, text(b.exclusiveGroup, 40), text(b.preset, 30)];
  const set = `account_id=$2, title=$3, merchants=$4, benefit_type=$5, benefit_value=$6, max_benefit=$7, min_spend=$8, reward_unit=$9, valid_from=$10, valid_to=$11, active=$12,
    verify_status=$13, source_url=$14, notes=$15, last_checked_on=$16, payment_mode=$17, weekdays=$18, coupon_code=$19, frequency=$20, max_uses=$21, period=$22, cycle_day=$23,
    period_max_uses=$24, period_max_benefit=$25, max_spend=$26, block_amount=$27, program_id=$28, apply_mode=$29, exclusive_group=$30, preset=$31, updated_at=now()`;
  if (b.id) {
    if (!isUuid(b.id)) throw httpError(400, 'Invalid offer');
    const rows = await db.query(`UPDATE wealth_account_offers SET ${set} WHERE id=$32 AND user_id=$1 RETURNING id`, [...vals, b.id]);
    if (!rows.length) throw httpError(404, 'Offer not found');
    return { id: rows[0].id, saved: true };
  }
  const rows = await db.query(`INSERT INTO wealth_account_offers (user_id, account_id, title, merchants, benefit_type, benefit_value, max_benefit, min_spend, reward_unit, valid_from, valid_to,
    active, verify_status, source_url, notes, last_checked_on, payment_mode, weekdays, coupon_code, frequency, max_uses, period, cycle_day, period_max_uses, period_max_benefit,
    max_spend, block_amount, program_id, apply_mode, exclusive_group, preset)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING id`, vals);
  return { id: rows[0].id, saved: true };
}

// Deleting an offer keeps the history of what it earned (the earnings keep their title and lose only the link to the offer).
export async function deleteOffer(uid, id, { db = sql } = {}) {
  if (!isUuid(id)) throw httpError(400, 'Invalid offer');
  const rows = await db.query('DELETE FROM wealth_account_offers WHERE id=$1 AND user_id=$2 RETURNING id', [id, uid]);
  if (!rows.length) throw httpError(404, 'Offer not found');
  return { deleted: true };
}

// ---- applying offers to an accepted payment -------------------------------------------------------------------------------
// offerIds: the offers the owner chose (the Accept screen pre-ticks the automatic ones); null/undefined = every automatic one.
// An offer that no longer matches (a one-time offer already used, a cap reached) is skipped, never forced.
export async function applyOffers(uid, tx, offerIds, { db = sql, actor = 'user' } = {}) {
  const { offers, uses, programs } = await activeOffersFor(uid, [tx.account_id], { db });
  const matched = matchOffers(offers, tx, uses, programs);
  const chosen = Array.isArray(offerIds) ? new Set(offerIds.filter(isUuid)) : null;
  const pick = bestPerGroup(matched.filter(m => !m.shadowed && (chosen ? chosen.has(m.id) : m.apply === 'auto')));
  if (!pick.length) return { applied: [], matched };
  const day = String(tx.occurred_on).slice(0, 10);
  const results = await withActor(db, actor, pick.map(m => [`INSERT INTO wealth_offer_uses (user_id, offer_id, transaction_id, used_on, benefit, title, kind, units, program_id, percent, status)
    VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,'expected')
    ON CONFLICT (offer_id, transaction_id) WHERE transaction_id IS NOT NULL DO UPDATE SET status='expected', benefit=EXCLUDED.benefit, units=EXCLUDED.units, percent=EXCLUDED.percent, updated_at=now()
      WHERE wealth_offer_uses.status = 'cancelled' RETURNING id`,
    [uid, m.id, tx.id, day, m.inr ?? 0, m.title, m.kind, m.units, m.programId, m.percent]]));
  const applied = pick.map((m, i) => (results[i].length ? { id: results[i][0].id, offerId: m.id, title: m.title, kind: m.kind, unit: m.unit, amount: m.amount, units: m.units, inr: m.inr, percent: m.percent, programName: m.programName } : null)).filter(Boolean);
  return { applied, matched };
}

// ---- earnings: show, receive, remove --------------------------------------------------------------------------------------
const EARN_COLS = `u.id, u.offer_id, u.transaction_id, u.used_on::text AS used_on, u.title, u.kind, u.benefit::float8 AS inr, u.units::float8 AS units,
  (SELECT p.unit FROM wealth_reward_programs p WHERE p.id = u.program_id) AS unit,
  u.percent::float8 AS percent, u.status, u.program_id, u.credited_transaction_id, u.credited_on::text AS credited_on`;

export async function earningsForTransactions(uid, txIds, { db = sql } = {}) {
  if (!txIds.length) return new Map();
  const rows = await db.query(`SELECT ${EARN_COLS} FROM wealth_offer_uses u WHERE u.user_id=$1 AND u.transaction_id = ANY($2::uuid[]) AND u.status <> 'cancelled' ORDER BY u.created_at`, [uid, txIds]);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.transaction_id)) by.set(r.transaction_id, []); by.get(r.transaction_id).push(r); }
  return by;
}

// Cashback / reward credits that arrived as income transactions and are not yet linked to an earning.
async function unlinkedCredits(uid, db) {
  return db.query(`SELECT t.id, t.amount::float8 AS amount, t.occurred_on::text AS occurred_on, t.category, t.description, t.account_id
    FROM wealth_transactions t WHERE t.user_id=$1 AND t.kind='income' AND t.duplicate_of IS NULL AND t.occurred_on > (now() AT TIME ZONE 'Asia/Kolkata')::date - 120
      AND (coalesce(t.category,'') || ' ' || coalesce(t.description,'')) ~* '(cashback|reward)'
      AND NOT EXISTS (SELECT 1 FROM wealth_offer_uses u WHERE u.credited_transaction_id = t.id) ORDER BY t.occurred_on`, [uid]);
}

// The earnings to show on the Rewards page: money still to arrive (with a suggested credit when one looks right), money received,
// and points earned. `suggest`: the nearest unlinked credit within ₹1 of the expected amount, dated on/after the payment.
export async function listEarnings(uid, { db = sql, limit = 40 } = {}) {
  // Money still to arrive is never cut off (the header total counts all of it); received money and points show only the latest few.
  const rows = await db.query(`SELECT ${EARN_COLS}, t.description AS tx_description, t.amount::float8 AS tx_amount, t.account_id,
      coalesce(nullif(trim(a.account_name || ' ' || coalesce(a.masked_identifier,'')),''), 'Account') AS account, p.name AS program_name, p.unit AS program_unit
    FROM wealth_offer_uses u LEFT JOIN wealth_transactions t ON t.id=u.transaction_id LEFT JOIN wealth_accounts a ON a.id=t.account_id LEFT JOIN wealth_reward_programs p ON p.id=u.program_id
    WHERE u.user_id=$1 AND u.status <> 'cancelled' AND ((u.status = 'expected' AND u.kind <> 'points') OR u.id IN (SELECT id FROM wealth_offer_uses WHERE user_id=$1 AND status <> 'cancelled' ORDER BY used_on DESC, created_at DESC LIMIT $2))
    ORDER BY u.used_on DESC, u.created_at DESC LIMIT 500`, [uid, limit]);   // every cashback still to arrive is listed (it is also in the total); the rest is the latest few
  const credits = rows.some(r => r.status === 'expected' && r.kind !== 'points') ? await unlinkedCredits(uid, db) : [];
  const taken = new Set();
  // Older payments claim a credit first (a statement credit usually belongs to the oldest waiting cashback of that amount).
  const claim = new Map();
  for (const i of rows.map((r, k) => k).sort((x, y) => rows[x].used_on.localeCompare(rows[y].used_on))) {
    const r = rows[i];
    let suggest = null;
    if (r.status === 'expected' && r.kind !== 'points') {
      const cand = credits.filter(c => !taken.has(c.id) && c.occurred_on >= r.used_on && Math.abs(c.amount - r.inr) <= 1).sort((x, y) => Math.abs(x.amount - r.inr) - Math.abs(y.amount - r.inr) || x.occurred_on.localeCompare(y.occurred_on))[0];
      if (cand) { suggest = { transactionId: cand.id, amount: cand.amount, date: cand.occurred_on, category: cand.category }; taken.add(cand.id); }
    }
    claim.set(i, suggest);
  }
  const earnings = rows.map((r, i) => ({ ...r, suggest: claim.get(i) || null }));
  const [tot] = await db.query(`SELECT
      coalesce(sum(benefit) FILTER (WHERE status='expected' AND kind <> 'points'), 0)::float8 AS money_expected,
      coalesce(sum(benefit) FILTER (WHERE status='received' AND kind <> 'points'), 0)::float8 AS money_received,
      count(*) FILTER (WHERE status='expected' AND kind <> 'points')::int AS money_expected_count
    FROM wealth_offer_uses WHERE user_id=$1 AND status <> 'cancelled'`, [uid]);
  return { earnings, totals: tot };
}

// received (optionally linked to the income transaction that carried the credit) | expected (reopen) | cancelled (remove)
export async function setEarningStatus(uid, { earningId, status, creditedTransactionId = null, creditedOn = null }, { db = sql, actor = 'user' } = {}) {
  if (!isUuid(earningId)) throw httpError(400, 'earningId must be an id');
  if (!['received', 'expected', 'cancelled'].includes(status)) throw httpError(400, 'status must be received, expected or cancelled');
  const [e] = await db.query(`SELECT id, status, used_on::text AS used_on FROM wealth_offer_uses WHERE id=$1 AND user_id=$2`, [earningId, uid]);
  if (!e) throw httpError(404, 'Earning not found');
  let credit = null;
  if (creditedTransactionId) {
    if (!isUuid(creditedTransactionId)) throw httpError(400, 'creditedTransactionId must be a transaction id');
    [credit] = await db.query(`SELECT id, occurred_on::text AS occurred_on FROM wealth_transactions WHERE id=$1 AND user_id=$2 AND kind='income'`, [creditedTransactionId, uid]);
    if (!credit) throw httpError(404, 'The credit must be one of your income transactions.');
    const [taken] = await db.query(`SELECT 1 FROM wealth_offer_uses WHERE credited_transaction_id=$1 AND id <> $2`, [creditedTransactionId, earningId]);
    if (taken) throw httpError(409, 'That credit is already linked to another earning.');
  }
  if (creditedOn && !isDay(creditedOn)) throw httpError(400, 'creditedOn must be YYYY-MM-DD');
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_offer_uses SET status=$3, updated_at=now(),
      credited_transaction_id = CASE WHEN $3='received' THEN $4::uuid ELSE NULL END,
      credited_on = CASE WHEN $3='received' THEN coalesce($5::date, $6::date, (now() AT TIME ZONE 'Asia/Kolkata')::date) ELSE NULL END
    WHERE id=$1 AND user_id=$2 RETURNING id, status`, [earningId, uid, status, credit ? credit.id : null, creditedOn, credit ? credit.occurred_on : null]]]);
  return rows[0];
}

// Undo the latest recorded use of an offer (a mistake): it is marked cancelled and stops counting toward the limits.
export async function undoLastUse(uid, offerId, { db = sql, actor = 'user' } = {}) {
  if (!isUuid(offerId)) throw httpError(400, 'Invalid offer');
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_offer_uses SET status='cancelled', credited_transaction_id=NULL, credited_on=NULL, updated_at=now() WHERE id = (SELECT id FROM wealth_offer_uses
    WHERE user_id=$1 AND offer_id=$2 AND status <> 'cancelled' ORDER BY used_on DESC, created_at DESC LIMIT 1) RETURNING id`, [uid, offerId]]]);
  if (!rows.length) throw httpError(404, 'This offer has no recorded use.');
  return { undone: true };
}

// Delete a payment: the rewards it earned are cancelled in the same transaction (kept, no longer counted, their credit link freed).
export async function deleteTransaction(uid, id, { db = sql, actor = 'user' } = {}) {
  const [, rows] = await withActor(db, actor, [
    [`UPDATE wealth_offer_uses SET status='cancelled', credited_transaction_id=NULL, credited_on=NULL, updated_at=now() WHERE user_id=$1 AND transaction_id=$2 AND status <> 'cancelled' RETURNING id`, [uid, id]],
    ['DELETE FROM wealth_transactions WHERE id=$1 AND user_id=$2 RETURNING id', [id, uid]],
  ]);
  return rows;
}
