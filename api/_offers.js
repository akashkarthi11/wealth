import { sql, isUuid, isDay, httpError } from './_lib.js';

// Account offers (0030, owner 2026-11-14). Card / account offers kept on a screen. On Accept of a payment, the offers of the
// payment's account that match are shown with the benefit they should give. The owner records "I used it", so limits are counted.
// Nothing is credited automatically.
//
// An offer can say:
//   who/what   account or card, payee words, how it was paid (any / UPI / credit-card account), coupon code, weekdays
//   how much   percent or flat, cap per payment, minimum spend, reward kind (cashback, points, coins, monies, coupon, discount)
//   how often  unlimited, one time only, or a number of uses in total
//   per period uses and/or benefit cap per day, week, month, billing cycle (statement day) or year
//   when       valid from / to, on or off
//   trust      "to verify" or "verified", source link, last checked
export const REWARD_UNITS = ['cashback', 'points', 'coins', 'monies', 'coupon', 'discount'];
export const FREQUENCIES = ['unlimited', 'one_time', 'limited'];
export const PERIODS = ['none', 'day', 'week', 'month', 'cycle', 'year'];
export const PAYMENT_MODES = ['any', 'upi', 'card'];
const r2 = n => Math.round(n * 100) / 100;
const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const numOrNull = v => (v === '' || v == null ? null : Number(v));
const intOrNull = v => (v === '' || v == null ? null : Number(v));

export function normMerchants(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  return [...new Set(list.map(x => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 10);
}
const normWeekdays = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim()).filter(x => x !== '').map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort();

// What an offer gives on one payment of `amount` before any period cap. percent: amount x value%, cut at max_benefit. flat: the value.
export function offerBenefit(o, amount) {
  const v = Number(o.benefit_value), cap = o.max_benefit == null ? null : Number(o.max_benefit);
  const raw = o.benefit_type === 'percent' ? Number(amount) * v / 100 : v;
  return r2(cap != null ? Math.min(raw, cap) : raw);
}

const dayMs = 864e5;
const toDay = ms => new Date(ms).toISOString().slice(0, 10);
const fromDay = d => Date.parse(d + 'T00:00:00Z');
const addMonths = (d, n) => { const t = new Date(fromDay(d)); return toDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, t.getUTCDate())); };

// The period [start, end) that holds `day` (YYYY-MM-DD): calendar day / week (Monday start) / month / year, or a billing cycle that
// starts on `cycleDay` of the month.
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

// Where does this offer stand for a payment on `day`, given the uses recorded so far?
//   usedTotal / usesLeft (null = no limit), periodUses / periodBenefit in the period that holds `day`, and whether it is exhausted.
export function offerStanding(o, uses, day) {
  const mine = uses.filter(u => u.offer_id === o.id);
  const totalCap = o.frequency === 'one_time' ? 1 : o.frequency === 'limited' ? Number(o.max_uses) : null;
  const win = o.period && o.period !== 'none' ? periodWindow(o.period, o.cycle_day, day) : null;
  const inWin = win ? mine.filter(u => String(u.used_on).slice(0, 10) >= win[0] && String(u.used_on).slice(0, 10) < win[1]) : [];
  const periodUses = inWin.length, periodBenefit = r2(inWin.reduce((s, u) => s + Number(u.benefit), 0));
  const usesLeftTotal = totalCap == null ? null : Math.max(totalCap - mine.length, 0);
  const usesLeftPeriod = win && o.period_max_uses != null ? Math.max(Number(o.period_max_uses) - periodUses, 0) : null;
  const benefitLeftPeriod = win && o.period_max_benefit != null ? r2(Math.max(Number(o.period_max_benefit) - periodBenefit, 0)) : null;
  const exhausted = usesLeftTotal === 0 ? 'used up' : usesLeftPeriod === 0 ? 'period limit reached' : benefitLeftPeriod === 0 ? 'period benefit limit reached' : null;
  return { usedTotal: mine.length, usesLeftTotal, periodUses, periodBenefit, usesLeftPeriod, benefitLeftPeriod, window: win, exhausted };
}

// Does the offer apply to this payment? tx: {account_id, kind, category, description, amount, occurred_on, subtype_code}.
// Same account, on, inside its dates and weekdays, over the minimum spend, a payment going out, paid the way the offer asks, the payee
// contains a merchant word (none = any payee) and no limit is used up.
export function offerMatches(o, tx, uses = []) {
  if (!o.active || o.account_id !== tx.account_id) return false;
  const day = String(tx.occurred_on).slice(0, 10);
  if (o.valid_from && day < String(o.valid_from).slice(0, 10)) return false;
  if (o.valid_to && day > String(o.valid_to).slice(0, 10)) return false;
  if (o.weekdays?.length && !o.weekdays.includes(new Date(fromDay(day)).getUTCDay())) return false;
  if (o.min_spend != null && Number(tx.amount) < Number(o.min_spend)) return false;
  if (!['expense', 'investment', 'liability'].includes(tx.kind)) return false;
  const hay = `${tx.description || ''} ${tx.category || ''}`.toLowerCase();
  if (o.payment_mode === 'upi' && !/\bupi\b/.test(hay)) return false;
  if (o.payment_mode === 'card' && tx.subtype_code !== 'credit_card') return false;
  const words = o.merchants || [];
  if (words.length && !words.some(w => hay.includes(w))) return false;
  return !offerStanding(o, uses, day).exhausted;
}

export function matchOffers(offers, tx, uses = []) {
  const day = String(tx.occurred_on).slice(0, 10);
  return offers.filter(o => offerMatches(o, tx, uses)).map(o => {
    const st = offerStanding(o, uses, day);
    const expected = r2(Math.min(offerBenefit(o, tx.amount), st.benefitLeftPeriod ?? Infinity));
    return {
      id: o.id, title: o.title, rewardUnit: o.reward_unit, benefitType: o.benefit_type, benefitValue: Number(o.benefit_value),
      maxBenefit: o.max_benefit == null ? null : Number(o.max_benefit), expected, couponCode: o.coupon_code || null, verifyStatus: o.verify_status, notes: o.notes || null,
      oneTime: o.frequency === 'one_time', usesLeftTotal: st.usesLeftTotal, usesLeftPeriod: st.usesLeftPeriod, benefitLeftPeriod: st.benefitLeftPeriod,
    };
  }).filter(m => m.expected > 0).sort((a, b) => b.expected - a.expected);
}

const COLS = `o.id, o.account_id, o.title, o.merchants, o.payment_mode, o.weekdays, o.coupon_code, o.benefit_type, o.benefit_value::float8 AS benefit_value,
  o.max_benefit::float8 AS max_benefit, o.min_spend::float8 AS min_spend, o.reward_unit, o.frequency, o.max_uses, o.period, o.cycle_day, o.period_max_uses,
  o.period_max_benefit::float8 AS period_max_benefit, o.valid_from::text AS valid_from, o.valid_to::text AS valid_to, o.active, o.verify_status,
  o.source_url, o.notes, o.last_checked_on::text AS last_checked_on`;

export async function usesFor(uid, offerIds, { db = sql } = {}) {
  if (!offerIds.length) return [];
  return db.query(`SELECT offer_id, used_on::text AS used_on, benefit::float8 AS benefit, transaction_id FROM wealth_offer_uses WHERE user_id=$1 AND offer_id = ANY($2::uuid[])`, [uid, offerIds]);
}

export async function activeOffersFor(uid, accountIds, { db = sql } = {}) {
  if (!accountIds.length) return { offers: [], uses: [] };
  const offers = await db.query(`SELECT ${COLS} FROM wealth_account_offers o WHERE o.user_id=$1 AND o.active AND o.account_id = ANY($2::uuid[])`, [uid, accountIds]);
  return { offers, uses: await usesFor(uid, offers.map(o => o.id), { db }) };
}

export async function listOffers(uid, { db = sql, today = new Date().toISOString().slice(0, 10) } = {}) {
  const [offers, accounts] = await Promise.all([
    db.query(`SELECT ${COLS}, a.bank_name, a.account_name, a.masked_identifier FROM wealth_account_offers o JOIN wealth_accounts a ON a.id=o.account_id
      WHERE o.user_id=$1 ORDER BY a.bank_name, a.account_name, o.active DESC, o.title`, [uid]),
    db.query(`SELECT id, bank_name, account_name, masked_identifier, subtype_code FROM wealth_accounts WHERE user_id=$1 AND status='active' ORDER BY bank_name, account_name`, [uid]),
  ]);
  const uses = await usesFor(uid, offers.map(o => o.id), { db });
  return {
    offers: offers.map(o => ({ ...o, standing: offerStanding(o, uses, today), benefitTotal: r2(uses.filter(u => u.offer_id === o.id).reduce((s, u) => s + Number(u.benefit), 0)) })),
    accounts, rewardUnits: REWARD_UNITS, frequencies: FREQUENCIES, periods: PERIODS, paymentModes: PAYMENT_MODES,
  };
}

export async function saveOffer(uid, b, { db = sql } = {}) {
  if (!isUuid(b?.accountId)) throw httpError(400, 'Choose the account or card this offer belongs to.');
  const [acc] = await db.query('SELECT id FROM wealth_accounts WHERE id=$1 AND user_id=$2', [b.accountId, uid]);
  if (!acc) throw httpError(404, 'Account not found');
  const title = text(b.title, 120); if (!title) throw httpError(400, 'Give the offer a title.');
  const type = String(b.benefitType || ''); if (!['percent', 'flat'].includes(type)) throw httpError(400, 'Benefit must be a percent or a flat amount.');
  const value = Number(b.benefitValue);
  if (!(value > 0) || (type === 'percent' && value > 100) || value > 1e7) throw httpError(400, type === 'percent' ? 'Percent must be above 0 and at most 100.' : 'Flat amount must be above 0.');
  const max = numOrNull(b.maxBenefit); if (max != null && !(max > 0 && max <= 1e9)) throw httpError(400, 'Maximum benefit must be above 0.');
  const min = numOrNull(b.minSpend); if (min != null && !(min >= 0 && min <= 1e12)) throw httpError(400, 'Minimum spend must be 0 or more.');
  const unit = String(b.rewardUnit || 'cashback'); if (!REWARD_UNITS.includes(unit)) throw httpError(400, 'Reward must be one of ' + REWARD_UNITS.join(', '));
  const mode = String(b.paymentMode || 'any'); if (!PAYMENT_MODES.includes(mode)) throw httpError(400, 'Payment way must be any, upi or card.');
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
  const weekdays = normWeekdays(b.weekdays);
  if (Array.isArray(b.weekdays) && b.weekdays.length && !weekdays.length) throw httpError(400, 'Weekdays are 0 (Sunday) to 6 (Saturday).');
  const from = b.validFrom || null, to = b.validTo || null, checked = b.lastCheckedOn || null;
  for (const d of [from, to, checked]) if (d && !isDay(d)) throw httpError(400, 'Dates must be YYYY-MM-DD.');
  if (from && to && to < from) throw httpError(400, 'Valid to is before valid from.');
  const url = text(b.sourceUrl, 300); if (url && !/^https?:\/\//i.test(url)) throw httpError(400, 'Source link must start with http:// or https://');
  const verify = b.verifyStatus === 'verified' ? 'verified' : 'to_verify';
  const vals = [uid, b.accountId, title, normMerchants(b.merchants), type, value, max, min, unit, from, to, b.active === false ? false : true, verify, url, text(b.notes, 300), checked,
    mode, weekdays, text(b.couponCode, 40), frequency, maxUses, period, cycleDay, periodUses, periodBenefit];
  const set = `account_id=$2, title=$3, merchants=$4, benefit_type=$5, benefit_value=$6, max_benefit=$7, min_spend=$8, reward_unit=$9, valid_from=$10, valid_to=$11, active=$12,
    verify_status=$13, source_url=$14, notes=$15, last_checked_on=$16, payment_mode=$17, weekdays=$18, coupon_code=$19, frequency=$20, max_uses=$21, period=$22, cycle_day=$23,
    period_max_uses=$24, period_max_benefit=$25, updated_at=now()`;
  if (b.id) {
    if (!isUuid(b.id)) throw httpError(400, 'Invalid offer');
    const rows = await db.query(`UPDATE wealth_account_offers SET ${set} WHERE id=$26 AND user_id=$1 RETURNING id`, [...vals, b.id]);
    if (!rows.length) throw httpError(404, 'Offer not found');
    return { id: rows[0].id, saved: true };
  }
  const rows = await db.query(`INSERT INTO wealth_account_offers (user_id, account_id, title, merchants, benefit_type, benefit_value, max_benefit, min_spend, reward_unit, valid_from, valid_to,
    active, verify_status, source_url, notes, last_checked_on, payment_mode, weekdays, coupon_code, frequency, max_uses, period, cycle_day, period_max_uses, period_max_benefit)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`, vals);
  return { id: rows[0].id, saved: true };
}

export async function deleteOffer(uid, id, { db = sql } = {}) {
  if (!isUuid(id)) throw httpError(400, 'Invalid offer');
  const rows = await db.query('DELETE FROM wealth_account_offers WHERE id=$1 AND user_id=$2 RETURNING id', [id, uid]);
  if (!rows.length) throw httpError(404, 'Offer not found');
  return { deleted: true };
}

// "I used this offer" on a payment. The offer must still match that payment (so a one-time offer cannot be used twice).
export async function recordOfferUses(uid, tx, offerIds, { db = sql } = {}) {
  const ids = [...new Set((offerIds || []).filter(isUuid))];
  if (!ids.length) return [];
  const { offers, uses } = await activeOffersFor(uid, [tx.account_id], { db });
  const ok = matchOffers(offers.filter(o => ids.includes(o.id)), tx, uses);
  const done = [];
  for (const m of ok) {
    const rows = await db.query(`INSERT INTO wealth_offer_uses (user_id, offer_id, transaction_id, used_on, benefit) VALUES ($1,$2,$3,$4::date,$5)
      ON CONFLICT (offer_id, transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING RETURNING id`, [uid, m.id, tx.id, String(tx.occurred_on).slice(0, 10), m.expected]);
    if (rows.length) done.push({ id: m.id, title: m.title, benefit: m.expected });
  }
  return done;
}

// Undo the latest recorded use of an offer (a mistake).
export async function undoLastUse(uid, offerId, { db = sql } = {}) {
  if (!isUuid(offerId)) throw httpError(400, 'Invalid offer');
  const rows = await db.query(`DELETE FROM wealth_offer_uses WHERE id = (SELECT id FROM wealth_offer_uses WHERE user_id=$1 AND offer_id=$2 ORDER BY used_on DESC, created_at DESC LIMIT 1) AND user_id=$1 RETURNING id`, [uid, offerId]);
  if (!rows.length) throw httpError(404, 'This offer has no recorded use.');
  return { undone: true };
}
