// Interest accrual engine (TSD Claude Plan 3, Phase 3). Replaces the arithmetic the daily agent used to do.
//   interest(D) = principal(D) × annual rate(D) ÷ (366 in a leap year, else 365), rounded to 8 decimals.
// Savings: principal = latest VERIFIED balance at the end of D (IST), at most 2 days old.
// FDs: principal from the recorded terms (simple, or compounded for cumulative deposits), until maturity.
// Rows are appended (revision 1); a changed result is a correction row (revision + 1, supersedes_id). Rows that
// carry bank evidence (calculation_status 'confirmed') are never corrected. Nothing is overwritten or removed.
import { sql, withActor, httpError, isDay, isUuid } from './_lib.js';

const DAY = 86400e3, IST_MS = 5.5 * 3600e3;
export const MAX_CATCH_UP_DAYS = 90, CORRECTION_WINDOW_DAYS = 30, FD_MAX_DAYS = 1200, STALE_PRINCIPAL_DAYS = 2;

export const istDay = (ms = Date.now()) => new Date(ms + IST_MS).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const startOfIstDay = d => Date.parse(d + 'T00:00:00+05:30');
const leap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const dayCount = d => (leap(Number(d.slice(0, 4))) ? 366 : 365);
export const round8 = x => Math.round(x * 1e8) / 1e8;
export const round2 = x => Math.round(x * 100) / 100;   // banks credit whole paise
export const endOfIstDay = d => Date.parse(d + 'T23:59:59+05:30');

// A balance the interest accrues from: verified, or one the assistant read from a screenshot / the owner accepted a transaction into
// (status 'reported', entered_by agent or accept) - those wait in Data quality for Confirm and are trusted until Rejected (0028).
export const isBase = b => b.status === 'verified' || (b.status === 'reported' && (b.entered_by === 'agent' || b.entered_by === 'accept'));
// Daily-credited products (Slice Savings, Atom): balance after day `through` = latest verified balance + interest
// credited on each day from the verified balance's IST date through `through` (each day rounded to paise).
// null when nothing was credited after the verified balance, or a verified balance is already newer.
export function estimatedBalance({ balances = [], dayTotals = new Map(), through }) {
  const base = balances.filter(isBase).sort((x, y) => new Date(y.as_of) - new Date(x.as_of))[0];
  if (!base || new Date(base.as_of).getTime() >= endOfIstDay(through)) return null;
  const from = istDay(new Date(base.as_of).getTime());
  const days = [...dayTotals.entries()].filter(([d]) => d >= from && d <= through).sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) return null;
  const credited = round2(days.reduce((s, [, amt]) => s + round2(amt), 0));
  return { balance: round2(Number(base.balance) + credited), asOf: new Date(endOfIstDay(through)).toISOString(), credited,
    note: `estimated: verified ₹${Number(base.balance)} at ${new Date(base.as_of).toISOString()} + interest ₹${credited} for ${days[0][0]}…${days[days.length - 1][0]}` };
}
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) - (Number(b.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0);
const PERIOD_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

export function rateFor(rates, d) {
  return rates.filter(r => r.effective_from <= d && (!r.effective_to || r.effective_to >= d))
    .sort((x, y) => y.effective_from.localeCompare(x.effective_from))[0] || null;
}

// How often the bank pays the interest into the account (2026-11-14: per account, set on the Interest page).
//   daily: paid every day (one "interest this month" row, updated each night).  monthly … yearly: accrued every day and paid at the
//   end of each period; the period length in months below. Periods are counted from the account's credit anchor (a start date).
export const FREQ_MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, half_yearly: 6, yearly: 12 };
export const CREDIT_FREQUENCIES = ['daily', ...Object.keys(FREQ_MONTHS), 'on_maturity'];
// Periods are counted from here when an account has no start of its own: whole calendar months / quarters (Jan, Apr, Jul, Oct) / halves.
export const DEFAULT_ANCHOR = '2020-01-01';
// d + n calendar months (the day is kept, or cut to the month's last day).
export function addMonthsISO(d, n) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12, last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yy, mm, Math.min(day, last))).toISOString().slice(0, 10);
}
// The credit periods [start, end] (end = the day the interest is paid) from `anchor`, every `months` months, that have ended by `through`.
export function creditPeriods(anchor, months, through, max = 600) {
  const out = [];
  if (!anchor || !(months > 0)) return out;
  for (let start = anchor, i = 0; i < max; i++) {
    const next = addMonthsISO(anchor, (i + 1) * months), end = addDays(next, -1);
    if (end > through) break;
    out.push({ start, end }); start = next;
  }
  return out;
}
// The period that holds `day` (the open one): {start, end}.
export function periodHolding(anchor, months, day) {
  if (!anchor || !(months > 0) || day < anchor) return null;
  let i = 0; while (addMonthsISO(anchor, (i + 1) * months) <= day && i < 600) i++;
  return { start: addMonthsISO(anchor, i * months), end: addDays(addMonthsISO(anchor, (i + 1) * months), -1) };
}

// Savings principal for day d: newest verified balance before the end of d and no older than `maxAgeDays` (2 by default) before d.
export function savingsPrincipal(balances, d, maxAgeDays = STALE_PRINCIPAL_DAYS) {
  const end = startOfIstDay(d) + DAY, oldest = startOfIstDay(d) - maxAgeDays * DAY;
  const b = balances.filter(x => isBase(x) && new Date(x.as_of).getTime() < end)
    .sort((x, y) => new Date(y.as_of) - new Date(x.as_of))[0];
  if (!b) return { problem: 'no verified balance' };
  if (new Date(b.as_of).getTime() < oldest) return { problem: 'stale balance', asOf: new Date(b.as_of).toISOString() };
  return { principal: Number(b.balance), asOf: new Date(b.as_of).toISOString() };
}

export function fdPrincipal(terms, d, rate) {
  const n = PERIOD_MONTHS[terms.compounding];
  if (terms.payout !== 'cumulative' || !n) return terms.principal;
  const periods = Math.floor(monthsBetween(terms.bookedOn, d) / n);
  return Math.round(terms.principal * Math.pow(1 + rate * n / 12, Math.max(periods, 0)) * 100) / 100;
}

// One source (account × product × partition): which days to accrue, and the rows or the reason each day is skipped.
// dailyCredit: the bank pays each day's interest into the account, so principal(D) also includes the interest
// credited since the verified balance (compounding, as at the bank).
// credit: {mode:'periodic', months, anchor}: the interest is paid at the end of each period, so from the day after it is paid the
// principal also includes it (compounding at the period, as at the bank). maxAgeDays: how old the balance may be (default 2).
export function planAccrual({ kind, balances = [], rates = [], terms = null, ledger = [], through, dailyCredit = false, credit = null, maxAgeDays = STALE_PRINCIPAL_DAYS }) {
  const periodic = credit && credit.mode === 'periodic' && FREQ_MONTHS && credit.months > 0 && credit.anchor ? credit : null;
  const byDay = new Map(), dayTotals = new Map();
  // Interest paid at the end of each closed period up to `upTo` (inclusive), from the days accrued so far: Map(end -> amount).
  const creditsThrough = upTo => {
    const m = new Map();
    if (!periodic) return m;
    for (const p of creditPeriods(periodic.anchor, periodic.months, upTo)) {
      const amt = round2([...dayTotals.entries()].filter(([day]) => day >= p.start && day <= p.end).reduce((s, [, a]) => s + a, 0));
      if (amt > 0) m.set(p.end, amt);
    }
    return m;
  };
  for (const r of ledger) {
    const l = byDay.get(r.accrual_date) || []; l.push(r); byDay.set(r.accrual_date, l);
    dayTotals.set(r.accrual_date, (dayTotals.get(r.accrual_date) || 0) + Number(r.interest_amount));
  }
  const last = [...byDay.keys()].sort().pop() || null;
  const rows = [], skipped = [];

  const compute = d => {
    const rate = rateFor(rates, d);
    if (!rate) return { problem: 'no rate' };
    let principal, basis;
    if (kind === 'fd') {
      principal = fdPrincipal(terms, d, Number(rate.annual_rate));
      basis = `FD ${terms.payout}${terms.compounding ? '/' + terms.compounding : ''} principal from terms`;
    } else {
      const p = savingsPrincipal(balances, d, maxAgeDays);
      if (p.problem) return p;
      principal = p.principal; basis = `verified balance as of ${p.asOf}`;
      if (dailyCredit) {
        const from = istDay(new Date(p.asOf).getTime());
        const credited = round2([...dayTotals.entries()].filter(([day]) => day >= from && day < d).reduce((s, [, amt]) => s + round2(amt), 0));
        if (credited) { principal = round2(principal + credited); basis += ` + ₹${credited} interest credited since`; }
      } else if (periodic) {
        const from = istDay(new Date(p.asOf).getTime());
        const credited = round2([...creditsThrough(addDays(d, -1)).entries()].filter(([end]) => end >= from).reduce((s, [, amt]) => s + amt, 0));
        if (credited) { principal = round2(principal + credited); basis += ` + ₹${credited} interest paid since`; }
      }
    }
    const dc = dayCount(d), annual = Number(rate.annual_rate);
    return { principal, rate, dc, interest: round8(principal * annual / dc), basis };
  };

  // 1. New days: from the day after the last accrual (or the first possible day) through `through`.
  let from;
  if (kind === 'fd') {
    if (!terms?.principal || !terms?.bookedOn || !terms?.payout) return { status: 'pending_terms', rows, skipped, last };
    from = last ? addDays(last, 1) : terms.bookedOn;
    if (addDays(through, -FD_MAX_DAYS) > from) from = addDays(through, -FD_MAX_DAYS);
  } else {
    const firstVerified = balances.filter(isBase).map(b => istDay(new Date(b.as_of).getTime())).sort()[0];
    from = last ? addDays(last, 1) : firstVerified;
    if (!from) return { status: 'stale_balance', rows, skipped: [{ day: through, reason: 'no verified balance' }], last };
    if (addDays(through, -MAX_CATCH_UP_DAYS) > from) from = addDays(through, -MAX_CATCH_UP_DAYS);
  }
  const until = kind === 'fd' && terms.maturityOn && addDays(terms.maturityOn, -1) < through ? addDays(terms.maturityOn, -1) : through;
  for (let d = from; d <= until; d = addDays(d, 1)) {
    const c = compute(d);
    if (c.problem) { skipped.push({ day: d, reason: c.problem }); continue; }
    dayTotals.set(d, (dayTotals.get(d) || 0) + c.interest);
    rows.push({ accrual_date: d, principal: c.principal, annual_rate: Number(c.rate.annual_rate), day_count: c.dc, interest_amount: c.interest,
      entry_type: 'accrual', revision: 1, supersedes_id: null, source_rate_id: c.rate.id, source_url: c.rate.source_url, calculation_status: 'estimated',
      notes: `${c.basis}; ${c.principal} × ${Number(c.rate.annual_rate)} ÷ ${c.dc}` });
  }

  // 2. Corrections for recent past days whose inputs changed (never for bank-confirmed days).
  const corrections = [];
  for (const [d, list] of byDay) {
    if (d < addDays(through, -CORRECTION_WINDOW_DAYS) || d > through) continue;
    if (list.some(r => r.calculation_status === 'confirmed')) continue;
    const c = compute(d); if (c.problem) continue;
    const effective = round8(list.reduce((s, r) => s + Number(r.interest_amount), 0));
    const delta = round8(c.interest - effective);
    if (Math.abs(delta) < 1e-8) continue;
    const latest = [...list].sort((x, y) => y.revision - x.revision)[0];
    corrections.push({ accrual_date: d, principal: c.principal, annual_rate: Number(c.rate.annual_rate), day_count: c.dc, interest_amount: delta,
      entry_type: 'correction', revision: latest.revision + 1, supersedes_id: latest.id, source_rate_id: c.rate.id, source_url: c.rate.source_url,
      calculation_status: 'corrected', notes: `correction: was ${effective}, now ${c.interest} (${c.basis}; ${c.principal} × ${Number(c.rate.annual_rate)} ÷ ${c.dc})` });
  }
  rows.push(...corrections);
  for (const c of corrections) dayTotals.set(c.accrual_date, (dayTotals.get(c.accrual_date) || 0) + c.interest_amount);
  const status = rows.length ? 'calculated' : skipped.some(s => s.reason === 'no rate') ? 'no_rate' : skipped.length ? 'stale_balance' : 'up_to_date';
  return { status, rows, skipped, last, corrections: corrections.length, dayTotals, creditTotals: creditsThrough(through) };
}

// Month-to-date interest for one daily-credited product, from the app's own records: the latest interest statement that
// starts in the month (bank figures to its end date) + nightly accruals after it. Written as ONE income transaction per
// account and month (external_ref interest-month:<product>:<YYYY-MM>), updated in place as days are added.
export async function upsertMonthInterestRow(db, uid, l, through, actor = 'cron') {
  const month = through.slice(0, 7);
  const [st] = await db.query(`SELECT period_end::text AS period_end, statement_total::float8 AS total FROM wealth_interest_statements
    WHERE user_id = $1 AND product_key = $2 AND to_char(period_start, 'YYYY-MM') = $3 ORDER BY period_end DESC LIMIT 1`, [uid, l.product_key, month]);
  const [led] = await db.query(`SELECT coalesce(sum(interest_amount), 0)::float8 AS amount, max(accrual_date)::text AS last FROM wealth_interest_ledger
    WHERE user_id = $1 AND account_key = $2 AND product_key = $3 AND to_char(accrual_date, 'YYYY-MM') = $4 AND ($5::date IS NULL OR accrual_date > $5::date)`,
    [uid, l.account_key, l.product_key, month, st ? st.period_end : null]);
  const amount = round2((st ? st.total : 0) + (led ? led.amount : 0));
  if (!(amount > 0)) return { month, amount: 0, written: false };
  const day = led && led.last ? led.last : st.period_end, ref = `interest-month:${l.product_key}:${month}`;
  const label = new Date(month + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const descr = `${l.account_name} interest · ${label} to date (app: ${st ? 'statement to ' + st.period_end.slice(8) + ' + ' : ''}nightly accrual)`;
  const [rows] = await withActor(db, actor, [[`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref, review_status)
      VALUES ($1, 'income', 'Interest', $2, $3, $4, $5, $6, $7, NULL)
      ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET amount = EXCLUDED.amount, occurred_on = EXCLUDED.occurred_on, description = EXCLUDED.description
      WHERE wealth_transactions.amount IS DISTINCT FROM EXCLUDED.amount OR wealth_transactions.occurred_on IS DISTINCT FROM EXCLUDED.occurred_on
      RETURNING id`, [uid, descr, amount, `${l.bank_name} · ${l.account_name}`, l.account_id, day, ref]]]);
  return { month, amount, through: day, written: rows.length > 0 };
}

// Daily interest, recorded as a NEW entry every day (record_mode 'day'): one income transaction per day, external_ref
// interest-day:<product>:<account>:<YYYY-MM-DD>, for the days of this month and last month. A late correction of a recent day
// updates that day's entry.
export async function upsertDayInterestRows(db, uid, l, dayTotals, through, actor = 'cron') {
  const from = addMonthsISO(through.slice(0, 8) + '01', -1);
  const days = [...dayTotals.entries()].filter(([d]) => d >= from && d <= through).sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) return { written: 0 };
  const stmts = days.map(([d, amt]) => [`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref, review_status)
      SELECT $1, 'income', 'Interest', $2, $3, $4, $5, $6, $7, NULL WHERE $3::numeric > 0
      ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET amount = EXCLUDED.amount
      WHERE wealth_transactions.amount IS DISTINCT FROM EXCLUDED.amount RETURNING id`,
    [uid, `${l.account_name} interest · ${d} (app: nightly accrual)`, round2(amt), `${l.bank_name} · ${l.account_name}`, l.account_id, d, `interest-day:${l.product_key}:${l.account_key}:${d}`]]);
  const res = await withActor(db, actor, stmts);
  return { written: res.filter(r => r.length).length, days: days.length };
}

// The two ways of recording daily interest never count twice: for this month and last month, the entries of the way NOT in use are
// marked as duplicates of the one in use (kept, left out of every total), and switching back undoes it.
export async function settleInterestRecordMode(db, uid, l, through, mode, actor = 'cron') {
  const months = [addMonthsISO(through.slice(0, 8) + '01', -1).slice(0, 7), through.slice(0, 7)];
  const stmts = [];
  for (const m of months) {
    const monthRef = `interest-month:${l.product_key}:${m}`, dayLike = `interest-day:${l.product_key}:${l.account_key}:${m}-%`;
    if (mode === 'day') {
      stmts.push([`UPDATE wealth_transactions t SET duplicate_of = d.id, duplicate_marked_at = now()
        FROM (SELECT id FROM wealth_transactions WHERE user_id = $1 AND external_ref LIKE $3 ORDER BY occurred_on DESC LIMIT 1) d
        WHERE t.user_id = $1 AND t.external_ref = $2 AND t.duplicate_of IS NULL RETURNING t.id`, [uid, monthRef, dayLike]]);
      stmts.push([`UPDATE wealth_transactions SET duplicate_of = NULL, duplicate_marked_at = NULL WHERE user_id = $1 AND external_ref LIKE $3
        AND duplicate_of IN (SELECT id FROM wealth_transactions WHERE user_id = $1 AND external_ref = $2) RETURNING id`, [uid, monthRef, dayLike]]);
    } else {
      stmts.push([`UPDATE wealth_transactions t SET duplicate_of = m.id, duplicate_marked_at = now()
        FROM (SELECT id FROM wealth_transactions WHERE user_id = $1 AND external_ref = $2) m
        WHERE t.user_id = $1 AND t.external_ref LIKE $3 AND t.duplicate_of IS NULL RETURNING t.id`, [uid, monthRef, dayLike]]);
      stmts.push([`UPDATE wealth_transactions SET duplicate_of = NULL, duplicate_marked_at = NULL WHERE user_id = $1 AND external_ref = $2
        AND duplicate_of IN (SELECT id FROM wealth_transactions WHERE user_id = $1 AND external_ref LIKE $3) RETURNING id`, [uid, monthRef, dayLike]]);
    }
  }
  await withActor(db, actor, stmts);
}

// Interest paid at the end of a period (monthly, every 2 months, quarterly …): ONE income transaction per account and period, on the
// day it is paid (external_ref interest-credit:<product>:<account>:<period end>). A later correction of a day inside the period
// updates the amount while the period ended less than 30 days ago; older credits are left as they are.
export async function postPeriodCredits(db, uid, l, creditTotals, through, actor = 'cron') {
  const out = [];
  for (const [end, amount] of creditTotals) {
    if (end > through || !(amount > 0)) continue;
    const ref = `interest-credit:${l.product_key}:${l.account_key}:${end}`;
    const label = { monthly: 'monthly', bimonthly: '2-monthly', quarterly: 'quarterly', half_yearly: 'half-yearly', yearly: 'yearly' }[l.credit_frequency] || 'period';
    const descr = `${l.account_name} interest paid · ${label} period to ${end} (app: nightly accrual)`;
    const recent = end >= addDays(through, -CORRECTION_WINDOW_DAYS);
    const [rows] = await withActor(db, actor, [[`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref, review_status)
        VALUES ($1, 'income', 'Interest', $2, $3, $4, $5, $6, $7, NULL)
        ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET amount = EXCLUDED.amount
        WHERE $8 AND wealth_transactions.amount IS DISTINCT FROM EXCLUDED.amount
        RETURNING id`, [uid, descr, amount, `${l.bank_name} · ${l.account_name}`, l.account_id, end, ref, recent]]]);
    out.push({ end, amount, written: rows.length > 0 });
  }
  return out;
}

// Run every linked source for one user, through yesterday (IST). Idempotent: unique keys make re-runs no-ops.
// accountId: run only that account (used right after the owner sets an account up, so the list fills at once).
export async function runAccrual(uid, { db = sql, now = Date.now(), dryRun = false, actor = 'cron', accountId = null } = {}) {
  const through = addDays(istDay(now), -1);
  // How the interest is paid can be set per account (link); otherwise the product's (catalogue) value applies.
  const linkQuery = cols => db.query(`SELECT l.account_id, l.partition_key, a.account_key, a.bank_name, a.account_name, a.subtype_code,
      a.fd_principal::float8 AS fd_principal, a.fd_booked_on::text AS fd_booked_on, a.fd_maturity_on::text AS fd_maturity_on, a.fd_payout, a.fd_compounding,
      p.id AS product_id, p.product_key, p.provider, ${cols}
    FROM wealth_interest_links l
    JOIN wealth_accounts a ON a.id = l.account_id AND a.user_id = $1 AND a.status = 'active'
    JOIN wealth_interest_products p ON p.id = l.product_id
    WHERE ($2::uuid IS NULL OR l.account_id = $2::uuid)
    ORDER BY a.bank_name, a.account_name`, [uid, accountId]);
  const links = await linkQuery(`coalesce(l.credit_frequency, p.credit_frequency) AS credit_frequency, l.credit_anchor::text AS credit_anchor, l.balance_max_age_days, coalesce(l.paused, false) AS paused, l.record_mode`)
    .catch(e => { if (e?.code !== '42703') throw e; return linkQuery('p.credit_frequency AS credit_frequency, NULL::text AS credit_anchor, NULL::int AS balance_max_age_days, false AS paused, NULL::text AS record_mode')
      .catch(e2 => { if (e2?.code === '42703') return linkQuery('NULL::text AS credit_frequency, NULL::text AS credit_anchor, NULL::int AS balance_max_age_days, false AS paused, NULL::text AS record_mode'); throw e2; }); });   // before 0034 / 0009
  const unlinked = await db.query(`SELECT a.account_key, a.bank_name, a.account_name FROM wealth_accounts a
    WHERE a.user_id=$1 AND a.status='active' AND a.subtype_code IN ('savings','fixed_deposit')
      AND NOT EXISTS (SELECT 1 FROM wealth_interest_links l WHERE l.account_id = a.id) ORDER BY 2, 3`, [uid]);
  const accounts = [];
  for (const l of links) {
    if (l.paused) { accounts.push({ accountKey: l.account_key, account: `${l.bank_name} · ${l.account_name}`, product: l.product_key, status: 'paused', rowsWritten: 0, corrections: 0, interestTotal: 0 }); continue; }
    const [rates, balances, ledger] = await Promise.all([
      db.query(`SELECT id, annual_rate::float8 AS annual_rate, effective_from::text AS effective_from, effective_to::text AS effective_to, source_url
        FROM wealth_interest_rates WHERE product_id=$1 OR (product_id IS NULL AND product_key=$2)`, [l.product_id, l.product_key]),
      db.query(`SELECT as_of, balance::float8 AS balance, status, entered_by FROM wealth_account_balances WHERE account_id=$1 AND rejected_at IS NULL AND as_of > $2::timestamptz ORDER BY as_of`,
        [l.account_id, new Date(now - (MAX_CATCH_UP_DAYS + 5) * DAY).toISOString()]),
      db.query(`SELECT id, accrual_date::text AS accrual_date, revision, interest_amount::float8 AS interest_amount, calculation_status, entry_type
        FROM wealth_interest_ledger WHERE user_id=$1 AND account_key=$2 AND product_key=$3 AND partition_key=$4`, [uid, l.account_key, l.product_key, l.partition_key]),
    ]);
    const kind = l.subtype_code === 'fixed_deposit' ? 'fd' : 'savings';
    const terms = kind === 'fd' ? { principal: l.fd_principal, bookedOn: l.fd_booked_on, maturityOn: l.fd_maturity_on, payout: l.fd_payout, compounding: l.fd_compounding } : null;
    const dailyCredit = kind === 'savings' && l.credit_frequency === 'daily';
    // Paid every N months: accrued daily, paid at the end of each period (periods counted from the account's anchor; default whole calendar months).
    const months = kind === 'savings' ? FREQ_MONTHS[l.credit_frequency] : undefined;
    const credit = months ? { mode: 'periodic', months, anchor: l.credit_anchor || DEFAULT_ANCHOR } : null;
    const maxAgeDays = Number(l.balance_max_age_days) > 0 ? Number(l.balance_max_age_days) : STALE_PRINCIPAL_DAYS;
    const plan = planAccrual({ kind, balances, rates, terms, ledger, through, dailyCredit, credit, maxAgeDays });
    let written = 0;
    if (plan.rows.length && !dryRun) {
      const payload = plan.rows.map(r => ({ ...r, provider: l.provider, product_key: l.product_key, account_key: l.account_key, partition_key: l.partition_key, account_id: l.account_id, product_id: l.product_id }));
      const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_interest_ledger (user_id, provider, product_key, account_key, partition_key, accrual_date, principal,
          annual_rate, day_count, interest_amount, entry_type, revision, supersedes_id, source_rate_id, source_url, calculation_status, notes, account_id, product_id)
        SELECT $1, r.provider, r.product_key, r.account_key, r.partition_key, r.accrual_date, r.principal, r.annual_rate, r.day_count, r.interest_amount,
          r.entry_type, r.revision, r.supersedes_id, r.source_rate_id, r.source_url, r.calculation_status, r.notes, r.account_id, r.product_id
        FROM jsonb_to_recordset($2::jsonb) AS r(provider text, product_key text, account_key text, partition_key text, accrual_date date, principal numeric,
          annual_rate numeric, day_count int, interest_amount numeric, entry_type text, revision int, supersedes_id uuid, source_rate_id uuid, source_url text,
          calculation_status text, notes text, account_id uuid, product_id uuid)
        ON CONFLICT DO NOTHING RETURNING id`, [uid, JSON.stringify(payload)]]]);
      written = ins.length;
    }
    // Interest paid into the account raises the balance (owner decision: marked 'estimated' until a verified balance arrives):
    // every day for daily products, at the end of each period for the others.
    let estimate = null;
    if (dailyCredit || credit) {
      const paid = dailyCredit ? plan.dayTotals : plan.creditTotals, lastDay = [...paid.keys()].filter(d => d <= through).sort().pop();
      estimate = lastDay ? estimatedBalance({ balances, dayTotals: paid, through: lastDay }) : null;
      if (estimate && !dryRun) {
        const [stored] = await withActor(db, actor, [
          // One rolling estimate per verified balance: move the estimate that follows the latest verified balance forward
          // (it is derived data — verified balance + ledger — so no information is lost); insert only when there is none.
          [`WITH base AS (SELECT max(as_of) AS v FROM wealth_account_balances WHERE account_id = $1 AND rejected_at IS NULL AND (status = 'verified' OR (status = 'reported' AND entered_by IN ('agent', 'accept')))),
            upd AS (UPDATE wealth_account_balances b SET as_of = $2, balance = $3, note = $4 FROM base
                    WHERE b.account_id = $1 AND b.status = 'estimated' AND b.as_of > coalesce(base.v, '-infinity'::timestamptz) AND b.as_of < $2
                      AND b.as_of = (SELECT max(as_of) FROM wealth_account_balances WHERE account_id = $1 AND status = 'estimated')
                    RETURNING b.as_of),
            ins AS (INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note) SELECT $1, $2, $3, 'estimated', $4
                    WHERE NOT EXISTS (SELECT 1 FROM upd) AND NOT EXISTS (SELECT 1 FROM wealth_account_balances WHERE account_id = $1 AND as_of >= $2)
                    ON CONFLICT (account_id, as_of) DO NOTHING RETURNING as_of)
            SELECT as_of FROM upd UNION ALL SELECT as_of FROM ins`, [l.account_id, estimate.asOf, estimate.balance, estimate.note]],
          // Legacy dashboard column ('stale' = estimated there; v1 still counts it and shows it as unverified).
          [`UPDATE wealth_accounts SET current_balance = $3, balance_as_of = $4, balance_status = 'stale', updated_at = now()
            WHERE user_id = $1 AND id = $2 AND balance_status IN ('verified', 'stale') AND (balance_as_of IS NULL OR balance_as_of < $4) RETURNING id`,
            [uid, l.account_id, estimate.balance, estimate.asOf]],
        ]);
        estimate.stored = stored.length > 0;
      }
    }
    // Daily-credited interest is real income: keep ONE "interest this month" transaction per account at the app's figure
    // (owner rule 11 Nov 2026: interest is never taken from screenshots; the task records it).
    const recordDays = dailyCredit && l.record_mode === 'day';
    const monthRow = dailyCredit && !recordDays && !dryRun ? await upsertMonthInterestRow(db, uid, l, through, actor).catch(e => ({ error: String(e?.message || e) })) : null;
    const dayRows = recordDays && !dryRun ? await upsertDayInterestRows(db, uid, l, plan.dayTotals, through, actor).catch(e => ({ error: String(e?.message || e) })) : null;
    if (dailyCredit && !dryRun) await settleInterestRecordMode(db, uid, l, through, recordDays ? 'day' : 'month', actor).catch(e => console.warn('[wealth-interest:record-mode]', e?.message || e));
    // Paid every N months: one income transaction per period, on the day it is paid.
    const periodCredits = credit && !dryRun ? await postPeriodCredits(db, uid, l, plan.creditTotals, through, actor).catch(e => ({ error: String(e?.message || e) })) : null;
    accounts.push({ accountKey: l.account_key, account: `${l.bank_name} · ${l.account_name}`, product: l.product_key, status: plan.status,
      monthInterest: monthRow, dayInterest: dayRows, periodCredits, creditFrequency: l.credit_frequency || null, estimatedBalance: estimate, lastAccrual: plan.last, rowsWritten: dryRun ? 0 : written, rowsPlanned: plan.rows.length, corrections: plan.corrections || 0,
      interestTotal: round8(plan.rows.reduce((s, r) => s + r.interest_amount, 0)), skipped: plan.skipped.slice(-5) });
  }
  if (accountId) return { through, dryRun, accounts };
  for (const a of unlinked) accounts.push({ accountKey: a.account_key, account: `${a.bank_name} · ${a.account_name}`, product: null, status: 'needs_link', rowsWritten: 0, corrections: 0, interestTotal: 0 });
  return { through, dryRun, accounts };
}

// TR3-3.2 A verified rate period. The previous open period gets an end date; the same rate twice is a no-op.
export async function submitRate(b, { db = sql, actor = 'agent', dryRun = false } = {}) {
  const productKey = String(b?.productKey || '').trim(), annualRate = Number(b?.annualRate), from = String(b?.effectiveFrom || '');
  const sourceUrl = String(b?.sourceUrl || '').trim().slice(0, 500), evidence = String(b?.evidence || '').trim().slice(0, 500);
  if (!(annualRate >= 0 && annualRate <= 1)) throw httpError(400, 'annualRate is a decimal fraction between 0 and 1 (5.5% = 0.055)');
  if (!isDay(from)) throw httpError(400, 'effectiveFrom must be YYYY-MM-DD');
  if (!sourceUrl) throw httpError(400, 'sourceUrl is required');
  const [p] = await db.query(`SELECT id, provider FROM wealth_interest_products WHERE product_key=$1`, [productKey]);
  if (!p) throw httpError(400, 'Unknown productKey');
  const [open] = await db.query(`SELECT id, annual_rate::float8 AS annual_rate, effective_from::text AS effective_from FROM wealth_interest_rates
    WHERE product_key=$1 AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`, [productKey]);
  if (open && Math.abs(open.annual_rate - annualRate) < 1e-9) return { status: 200, body: { result: 'unchanged', current: open } };
  if (open && from <= open.effective_from) throw httpError(409, `effectiveFrom must be after the current period's start (${open.effective_from})`);
  if (dryRun) return { status: 200, body: { result: 'would_record', closes: open?.id || null } };
  const stmts = [[`INSERT INTO wealth_interest_rates (provider, product_key, product_id, annual_rate, effective_from, source_url, source_checked_at, recorded_by, notes, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$8) RETURNING id, effective_from::text AS effective_from`, [p.provider, productKey, p.id, annualRate, from, sourceUrl, actor, evidence]]];
  if (open) stmts.push([`UPDATE wealth_interest_rates SET effective_to = $2::date - 1, notes = notes || $3 WHERE id=$1 RETURNING id`,
    [open.id, from, ` [closed ${new Date().toISOString().slice(0, 10)}: superseded by ${annualRate} from ${from}]`]]);
  const [ins] = await withActor(db, actor, stmts);
  return { status: 201, body: { result: 'recorded', rate: ins[0], closed: open?.id || null } };
}

// TR3-3.6 An actual interest credit with bank evidence: income transaction + verified balance, in one transaction.
export async function recordCredit(uid, b, { db = sql, actor = 'owner' } = {}) {
  const [a] = await db.query(`SELECT id, account_key, subtype_code FROM wealth_accounts WHERE user_id=$1 AND id=$2 AND status='active'`, [uid, String(b?.accountId || '')]).catch(() => []);
  if (!a || !['savings', 'current', 'fixed_deposit'].includes(a.subtype_code)) throw httpError(404, 'Interest-bearing account not found');
  const amount = Number(b.amount), on = String(b.creditedOn || '');
  if (!(amount > 0) || amount > 1e9) throw httpError(400, 'amount must be positive');
  if (!isDay(on)) throw httpError(400, 'creditedOn must be YYYY-MM-DD');
  const ref = String(b.reference || '').trim().slice(0, 120) || `interest:${a.account_key}:${on}:${amount.toFixed(2)}`;
  const stmts = [[`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref, review_status)
    VALUES ($1,'income','Interest',$2,$3,'',$4,$5,$6,NULL) RETURNING id`, [uid, String(b.description || 'Interest credited').slice(0, 180), amount, a.id, on, ref]]];
  if (b.newBalance !== undefined && b.newBalance !== null) {
    const bal = Number(b.newBalance), asOf = new Date(b.balanceAsOf || Date.now());
    if (!Number.isFinite(bal) || !Number.isFinite(asOf.getTime())) throw httpError(400, 'newBalance / balanceAsOf invalid');
    stmts.push([`INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note) VALUES ($1,$2,$3,'verified',$4) ON CONFLICT (account_id, as_of) DO NOTHING RETURNING as_of`,
      [a.id, asOf.toISOString(), bal, String(b.evidence || 'interest credit').slice(0, 300)]]);
    if (['savings', 'current'].includes(a.subtype_code)) stmts.push([`UPDATE wealth_accounts SET current_balance=$3, balance_as_of=$4, balance_status='verified', updated_at=now()
      WHERE user_id=$1 AND id=$2 AND (balance_as_of IS NULL OR balance_as_of < $4) RETURNING id`, [uid, a.id, bal, asOf.toISOString()]]);
  }
  try {
    const [tx] = await withActor(db, actor, stmts);
    return { transactionId: tx[0].id, reference: ref };
  } catch (e) {
    if (e?.code === '23505') throw httpError(409, 'This interest credit (reference) is already recorded');
    throw e;
  }
}

// ---- Interest set up by the owner (0034, 2026-11-14) -------------------------------------------------------------------------
// The owner adds a savings or current account on the Interest page with its rate per year and how often the bank pays the interest
// (every day, every month, every 2 months, quarterly, half-yearly, yearly). The app then works out the interest every night from the
// account's latest recorded balance, lists it, and adds it to the balance when it is paid. The rate belongs to the owner (a product of
// their own, rate periods kept: a new rate never rewrites the past). An account that already follows a catalogue product (Slice, Atom)
// keeps that product's rate; only how it is paid can be changed for it.
export const PAYABLE = ['daily', ...Object.keys(FREQ_MONTHS)];
export const OWN_MAX_AGE_DAYS = 60;     // an own account accrues from a balance up to 60 days old (catalogue products: 2 days); editable per account
const ownKey = accountId => 'my-' + accountId;

export async function saveInterestAccount(uid, b, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(b?.accountId)) throw httpError(400, 'Choose the account.');
  const [a] = await db.query(`SELECT id, account_key, bank_name, account_name, subtype_code FROM wealth_accounts WHERE id=$1 AND user_id=$2 AND status='active'`, [b.accountId, uid]);
  if (!a) throw httpError(404, 'Account not found');
  if (!['savings', 'current'].includes(a.subtype_code)) throw httpError(400, 'Interest by a yearly rate is for savings and current accounts. A fixed deposit uses its deposit terms.');
  const freq = String(b.creditFrequency || '');
  if (!PAYABLE.includes(freq)) throw httpError(400, 'How often is the interest paid? Choose daily, monthly, every 2 months, quarterly, half-yearly or yearly.');
  const today = istDay(now);
  let anchor = null;
  if (freq !== 'daily') {
    anchor = b.creditAnchor ? String(b.creditAnchor) : today.slice(0, 8) + '01';
    if (!isDay(anchor)) throw httpError(400, 'The first period start must be a date (YYYY-MM-DD).');
    if (anchor > addDays(today, 366)) throw httpError(400, 'The first period start is too far ahead.');
  }
  const hasRate = b.annualRatePercent !== undefined && b.annualRatePercent !== null && b.annualRatePercent !== '';
  const pct = hasRate ? Number(b.annualRatePercent) : null;
  if (hasRate && !(pct > 0 && pct <= 100)) throw httpError(400, 'The rate is a percent per year, above 0 and at most 100.');
  const annual = hasRate ? Math.round(pct * 1e6) / 1e8 : null;     // 6.5 -> 0.065
  const hasAge = b.balanceMaxAgeDays !== undefined && b.balanceMaxAgeDays !== null && b.balanceMaxAgeDays !== '';
  const maxAge = hasAge ? Number(b.balanceMaxAgeDays) : null;
  if (hasAge && !(Number.isInteger(maxAge) && maxAge >= 1 && maxAge <= 120)) throw httpError(400, 'The balance age must be 1 to 120 days.');
  const paused = b.paused === true;
  const recordMode = b.recordMode == null || b.recordMode === '' ? null : String(b.recordMode);
  if (recordMode && !['month', 'day'].includes(recordMode)) throw httpError(400, 'Daily interest is recorded as one entry per month (month) or a new entry every day (day).');

  const [link] = await db.query(`SELECT l.product_id, l.partition_key, p.product_key, p.user_id AS product_owner FROM wealth_interest_links l
    JOIN wealth_interest_products p ON p.id = l.product_id WHERE l.account_id = $1 ORDER BY (p.user_id IS NULL) LIMIT 1`, [a.id]);
  const stmts = [];
  let productKey, created = false, rateChange = null;
  if (!link) {
    if (!hasRate) throw httpError(400, 'Give the interest rate per year.');
    productKey = ownKey(a.id); created = true;
    // The rate also covers the last 90 days, so the balances already recorded earn interest at once.
    const from = b.effectiveFrom ? String(b.effectiveFrom) : addDays(today, -MAX_CATCH_UP_DAYS);
    if (!isDay(from)) throw httpError(400, 'The rate start must be a date (YYYY-MM-DD).');
    stmts.push([`INSERT INTO wealth_interest_products (product_key, provider, user_id, credit_frequency) VALUES ($1, $2, $3, $4)
      ON CONFLICT (product_key) DO UPDATE SET credit_frequency = EXCLUDED.credit_frequency WHERE wealth_interest_products.user_id = $3 RETURNING id`, [productKey, a.bank_name, uid, freq]]);
    stmts.push([`INSERT INTO wealth_interest_rates (provider, product_key, product_id, annual_rate, effective_from, source_url, recorded_by, notes, evidence)
      SELECT $1, $2, p.id, $3, $4, 'owner-entered', $5, 'Rate entered by the account owner on the Interest page', 'Entered by the account owner'
      FROM wealth_interest_products p WHERE p.product_key = $2 AND p.user_id = $6
        AND NOT EXISTS (SELECT 1 FROM wealth_interest_rates r WHERE r.product_key = $2) RETURNING id`, [a.bank_name, productKey, annual, from, actor, uid]]);
    stmts.push([`INSERT INTO wealth_interest_links (account_id, product_id, credit_frequency, credit_anchor, balance_max_age_days, paused, record_mode)
      SELECT $1, p.id, $3, $4, $5, $6, $8 FROM wealth_interest_products p WHERE p.product_key = $2 AND p.user_id = $7
      ON CONFLICT (account_id, product_id, partition_key) DO UPDATE SET credit_frequency = EXCLUDED.credit_frequency, credit_anchor = EXCLUDED.credit_anchor,
        balance_max_age_days = EXCLUDED.balance_max_age_days, paused = EXCLUDED.paused, record_mode = EXCLUDED.record_mode RETURNING account_id`, [a.id, productKey, freq, anchor, maxAge ?? OWN_MAX_AGE_DAYS, paused, uid, recordMode || 'month']]);
  } else {
    productKey = link.product_key;
    const own = link.product_owner === uid;
    stmts.push([`UPDATE wealth_interest_links SET credit_frequency = $3, credit_anchor = $4, balance_max_age_days = coalesce($5, balance_max_age_days), paused = $6, record_mode = coalesce($7, record_mode)
      WHERE account_id = $1 AND product_id = $2 RETURNING account_id`, [a.id, link.product_id, freq, anchor, maxAge, paused, recordMode]]);
    if (own) stmts.push([`UPDATE wealth_interest_products SET credit_frequency = $2 WHERE id = $1 AND user_id = $3 RETURNING id`, [link.product_id, freq, uid]]);
    if (hasRate) {
      if (!own) throw httpError(409, `This account follows the "${link.product_key}" rate, which is kept from the bank's published rate. You can change how the interest is paid, not the rate.`);
      const [open] = await db.query(`SELECT id, annual_rate::float8 AS annual_rate, effective_from::text AS effective_from FROM wealth_interest_rates
        WHERE product_key = $1 AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`, [productKey]);
      if (!open || Math.abs(open.annual_rate - annual) > 1e-9) {
        const from = b.effectiveFrom ? String(b.effectiveFrom) : today;
        if (!isDay(from)) throw httpError(400, 'The new rate start must be a date (YYYY-MM-DD).');
        if (open && from <= open.effective_from) throw httpError(409, `The new rate must start after ${open.effective_from}, when the current rate started.`);
        stmts.push([`INSERT INTO wealth_interest_rates (provider, product_key, product_id, annual_rate, effective_from, source_url, recorded_by, notes, evidence)
          VALUES ($1, $2, $3, $4, $5, 'owner-entered', $6, 'Rate entered by the account owner on the Interest page', 'Entered by the account owner') RETURNING id`, [a.bank_name, productKey, link.product_id, annual, from, actor]]);
        if (open) stmts.push([`UPDATE wealth_interest_rates SET effective_to = $2::date - 1, notes = notes || $3 WHERE id = $1 RETURNING id`, [open.id, from, ` [closed: the owner set ${pct}% from ${from}]`]]);
        rateChange = { from, ratePercent: pct, previousPercent: open ? Math.round(open.annual_rate * 1e8) / 1e6 : null };
      }
    }
  }
  await withActor(db, actor, stmts);
  // Work the interest out at once, so the list shows it without waiting for the night.
  const run = paused ? null : await runAccrual(uid, { db, now, actor, accountId: a.id }).catch(e => ({ error: String(e?.message || e) }));
  return { accountId: a.id, productKey, created, rateChange, run: run && run.accounts ? run.accounts[0] || null : run };
}

// TR3-3.7 Interest view: per linked source, the current rate, how it is paid, accrued totals and credits; the recent interest
// rows (the "list"); and the accounts that can be set up.
export async function interestOverview(uid, { db = sql, now = Date.now() } = {}) {
  const today = istDay(now), month = today.slice(0, 7);
  const linkCols = `coalesce(l.credit_frequency, p.credit_frequency) AS credit_frequency, l.credit_anchor::text AS credit_anchor, l.balance_max_age_days, l.paused, (p.user_id = $1) AS own, coalesce(l.record_mode, 'month') AS record_mode`;
  const query = cols => db.query(`SELECT a.id AS account_id, a.bank_name, a.account_name, a.masked_identifier, a.subtype_code, p.product_key, p.provider, ${cols},
      (SELECT annual_rate::float8 FROM wealth_interest_rates r WHERE r.product_key = p.product_key AND r.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS rate,
      (SELECT effective_from::text FROM wealth_interest_rates r WHERE r.product_key = p.product_key AND r.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS rate_from,
      (SELECT max(accrual_date)::text FROM wealth_interest_ledger g WHERE g.user_id = a.user_id AND g.account_key = a.account_key AND g.product_key = p.product_key) AS last_accrual,
      (SELECT coalesce(sum(interest_amount), 0)::float8 FROM wealth_interest_ledger g WHERE g.user_id = a.user_id AND g.account_key = a.account_key AND g.product_key = p.product_key
         AND to_char(accrual_date, 'YYYY-MM') = $2) AS accrued_month,
      (SELECT coalesce(sum(interest_amount), 0)::float8 FROM wealth_interest_ledger g WHERE g.user_id = a.user_id AND g.account_key = a.account_key AND g.product_key = p.product_key) AS accrued_total,
      (SELECT coalesce(sum(amount), 0)::float8 FROM wealth_transactions t WHERE t.user_id = a.user_id AND t.account_id = a.id AND t.kind = 'income' AND t.category = 'Interest' AND t.duplicate_of IS NULL) AS credited_total,
      (SELECT b.balance::float8 FROM wealth_v_latest_balances b WHERE b.account_id = a.id) AS balance,
      (SELECT b.as_of FROM wealth_v_latest_balances b WHERE b.account_id = a.id) AS balance_as_of,
      a.fd_principal::float8 AS fd_principal, a.fd_maturity_on::text AS fd_maturity_on
    FROM wealth_interest_links l JOIN wealth_accounts a ON a.id = l.account_id AND a.user_id = $1 AND a.status = 'active'
    JOIN wealth_interest_products p ON p.id = l.product_id ORDER BY a.bank_name, a.account_name`, [uid, month]);
  const sources = await query(linkCols).catch(e => { if (e?.code === '42703') return query(`p.credit_frequency, NULL::text AS credit_anchor, NULL::int AS balance_max_age_days, false AS paused, false AS own, 'month' AS record_mode`); throw e; });
  // Periodic accounts: the open period, what it has earned so far and when it is paid.
  for (const s of sources) {
    const months = s.subtype_code !== 'fixed_deposit' ? FREQ_MONTHS[s.credit_frequency] : undefined;
    s.max_age_days = Number(s.balance_max_age_days) > 0 ? Number(s.balance_max_age_days) : STALE_PRINCIPAL_DAYS;
    if (!months) { s.next_credit = s.credit_frequency === 'daily' ? today : null; s.period_accrued = null; continue; }
    const p = periodHolding(s.credit_anchor || DEFAULT_ANCHOR, months, today);
    s.period = p; s.next_credit = p ? p.end : null;
    const [r] = p ? await db.query(`SELECT coalesce(sum(interest_amount), 0)::float8 AS amount FROM wealth_interest_ledger g JOIN wealth_accounts a ON a.account_key = g.account_key AND a.user_id = g.user_id
      WHERE g.user_id = $1 AND a.id = $2 AND g.product_key = $3 AND g.accrual_date >= $4::date AND g.accrual_date <= $5::date`, [uid, s.account_id, s.product_key, p.start, p.end]) : [null];
    s.period_accrued = r ? round2(r.amount) : 0;
  }
  const unlinked = await db.query(`SELECT a.id, a.bank_name, a.account_name, a.masked_identifier, a.subtype_code FROM wealth_accounts a WHERE a.user_id=$1 AND a.status='active'
    AND a.subtype_code IN ('savings','current','fixed_deposit') AND NOT EXISTS (SELECT 1 FROM wealth_interest_links l WHERE l.account_id = a.id) ORDER BY 2, 3`, [uid]);
  const history = await db.query(`SELECT t.id, t.amount::float8 AS amount, t.occurred_on::text AS occurred_on, t.description, t.account_id, t.external_ref,
      coalesce(nullif(trim(a.account_name || ' ' || coalesce(a.masked_identifier,'')),''), 'Account') AS account
    FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.id = t.account_id
    WHERE t.user_id = $1 AND t.kind = 'income' AND t.category = 'Interest' AND t.duplicate_of IS NULL ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 200`, [uid]);
  return { month, today, sources, unlinked, history, frequencies: PAYABLE, ownMaxAgeDays: OWN_MAX_AGE_DAYS };
}
