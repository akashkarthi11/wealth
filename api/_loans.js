// Money lent and bill splits (TSD Claude Plan 4, Part B; migration 0020).
// People are the owner's own contacts (not app users). What a person owes = their shares of split bills + money lent
// (transfers / cash) − money paid back (+ simple interest when a rate is set). Transfers stay transfers and bills stay
// expenses: this only adds them up per person, so no other total changes. Suggestions are offered, never auto-created.
import { sql, withActor, httpError, isUuid, isDay } from './_lib.js';

const r2 = x => Math.round(x * 100) / 100;
const text = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);
const istToday = now => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const dayMs = 86400e3;

// "UPI transfer to Arun S", "Mr Arun S · UPI · HDFC statement · ref …" → "Arun S".
export function personOf(description) {
  let s = String(description || '').split(' · ')[0];
  s = s.replace(/^(upi\s+)?(transfer|payment|money)\s+(to|from)\s+/i, '').replace(/^(paid\s+to|received\s+from|sent\s+to)\s+/i, '');
  return s.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
}
const directionOf = t => (/received|from/i.test(String(t.category || '')) ? 'in' : 'out');

// Split paise across weights with largest-remainder rounding so the parts add up exactly.
function spread(paise, weights) {
  const total = weights.reduce((n, w) => n + w, 0);
  if (!(total > 0)) return weights.map(() => 0);
  const parts = weights.map((w, i) => { const raw = paise * w / total; return { i, p: Math.floor(raw), f: raw - Math.floor(raw) }; });
  let left = paise - parts.reduce((n, x) => n + x.p, 0);
  [...parts].sort((a, b) => b.f - a.f || a.i - b.i).forEach(x => { if (left > 0) { x.p++; left--; } });
  return parts.map(x => x.p);
}

// Bill split maths. total includes tax (GST). mode 'equal': everyone pays the same. mode 'amounts': each person's
// amount before tax is given; the owner's part is what is left. Tax is shared in proportion to each part.
export function computeShares({ total, tax = 0, mode, includeMe = true, people = [] }) {
  const T = Math.round(Number(total) * 100), X = Math.round(Number(tax || 0) * 100);
  if (!(T > 0) || T > 1e14) throw httpError(400, 'total must be more than 0');
  if (!(X >= 0) || X > T) throw httpError(400, 'GST / tax must be between 0 and the total');
  if (!people.length) throw httpError(400, 'Add at least one person to split with');
  if (!['equal', 'amounts'].includes(mode)) throw httpError(400, 'mode must be equal or amounts');
  const sub = T - X, keys = [...(includeMe ? ['me'] : []), ...people.map(p => p.key)];
  let bases;
  if (mode === 'equal') bases = spread(sub, keys.map(() => 1));
  else {
    const given = people.map(p => { const b = Math.round(Number(p.base) * 100); if (!(b >= 0) || !Number.isFinite(b)) throw httpError(400, `Amount for ${p.label || 'a person'} must be 0 or more`); return b; });
    const others = given.reduce((n, b) => n + b, 0);
    if (others > sub) throw httpError(400, `People's amounts (₹${r2(others / 100)}) are more than the bill before tax (₹${r2(sub / 100)})`);
    if (!includeMe && others !== sub) throw httpError(400, `Amounts must add up to ₹${r2(sub / 100)} (bill before tax) when you are not in the split`);
    bases = includeMe ? [sub - others, ...given] : given;
  }
  const taxes = mode === 'equal' ? spread(X, keys.map(() => 1)) : spread(X, bases);
  return keys.map((key, i) => ({ key, base: bases[i] / 100, tax: taxes[i] / 100, amount: (bases[i] + taxes[i]) / 100 }));
}

// Running balance with daily simple interest; repayments reduce interest first, then principal.
export function personFigures(moves, { annualRate = null, dueOn = null, status = 'open', today }) {
  const list = [...moves].sort((a, b) => String(a.on).localeCompare(String(b.on)));
  let principal = 0, interest = 0, lent = 0, repaid = 0, last = null;
  const rate = annualRate == null ? 0 : Number(annualRate);
  const accrue = to => { if (rate > 0 && last && principal > 0) interest += principal * rate * Math.max(0, (Date.parse(to) - Date.parse(last)) / dayMs) / 365; };
  for (const m of list) {
    const day = String(m.on).slice(0, 10), amt = Number(m.amount);
    accrue(day); last = day;
    if (m.direction === 'out') { lent += amt; principal += amt; }
    else { repaid += amt; const toInt = Math.min(interest, amt); interest -= toInt; principal -= amt - toInt; }
  }
  if (status === 'open') accrue(today);
  const owed = status === 'open' ? r2(Math.max(0, principal + interest)) : 0;
  return { lent: r2(lent), repaid: r2(repaid), interest: r2(Math.max(0, interest)), owed,
    overpaid: principal < -0.004 ? r2(-principal) : 0, lastMovement: list.length ? String(list[list.length - 1].on).slice(0, 10) : null,
    overdue: status === 'open' && !!dueOn && String(dueOn).slice(0, 10) < today && owed > 0 };
}

export async function loansOverview(uid, { db = sql, now = Date.now() } = {}) {
  const today = istToday(now);
  const [people, entries, shares, splits] = await Promise.all([
    db.query(`SELECT id, name, kind, due_on::text AS due_on, annual_rate::float8 AS annual_rate, status, note FROM wealth_people WHERE user_id = $1 ORDER BY lower(name)`, [uid]),
    db.query(`SELECT e.id, e.person_id, e.direction, e.amount::float8 AS amount, e.occurred_on::text AS on, e.transaction_id, e.note,
        t.description AS tx_description, coalesce(a.account_name, nullif(t.account, '')) AS account
      FROM wealth_person_entries e JOIN wealth_people p ON p.id = e.person_id AND p.user_id = $1
      LEFT JOIN wealth_transactions t ON t.id = e.transaction_id LEFT JOIN wealth_accounts a ON a.id = t.account_id
      ORDER BY e.occurred_on DESC, e.created_at DESC`, [uid]),
    db.query(`SELECT sh.split_id, sh.person_id, sh.base::float8 AS base, sh.tax::float8 AS tax, sh.amount::float8 AS amount
      FROM wealth_bill_split_shares sh JOIN wealth_bill_splits s ON s.id = sh.split_id AND s.user_id = $1 AND s.status = 'active'`, [uid]),
    db.query(`SELECT id, transaction_id, title, occurred_on::text AS on, total::float8 AS total, tax::float8 AS tax, mode, note
      FROM wealth_bill_splits WHERE user_id = $1 AND status = 'active' ORDER BY occurred_on DESC, created_at DESC`, [uid]),
  ]);
  const splitById = new Map(splits.map(s => [s.id, s]));
  const nameById = new Map(people.map(p => [p.id, p.name]));
  const out = people.map(p => {
    const items = [
      ...entries.filter(e => e.person_id === p.id).map(e => ({ type: e.transaction_id ? 'transfer' : 'manual', direction: e.direction, amount: e.amount, on: e.on,
        transactionId: e.transaction_id, entryId: e.id, label: e.direction === 'out' ? 'Lent' : 'Paid back', detail: e.tx_description || e.note, account: e.account })),
      ...shares.filter(s => s.person_id === p.id).map(s => { const b = splitById.get(s.split_id); return { type: 'bill', direction: 'out', amount: s.amount, on: b.on,
        splitId: b.id, transactionId: b.transaction_id, label: 'Share of ' + b.title, detail: s.tax ? `₹${s.base} + ₹${s.tax} GST` : null }; }),
    ].sort((a, b) => String(b.on).localeCompare(String(a.on)));
    return { id: p.id, name: p.name, kind: p.kind, dueOn: p.due_on, annualRate: p.annual_rate, status: p.status, note: p.note,
      ...personFigures(items, { annualRate: p.annual_rate, dueOn: p.due_on, status: p.status, today }),
      bills: items.filter(i => i.type === 'bill').length, items };
  });
  const active = out.filter(p => p.status === 'open');
  const splitList = splits.map(s => {
    const mine = shares.filter(x => x.split_id === s.id);
    const me = mine.find(x => x.person_id == null);
    return { id: s.id, transactionId: s.transaction_id, title: s.title, on: s.on, total: s.total, tax: s.tax, mode: s.mode,
      myShare: me ? me.amount : 0, othersOwe: r2(mine.filter(x => x.person_id).reduce((n, x) => n + x.amount, 0)),
      shares: mine.map(x => ({ personId: x.person_id, name: x.person_id ? nameById.get(x.person_id) : 'You', base: x.base, tax: x.tax, amount: x.amount }))
        .sort((a, b) => (a.personId ? 1 : 0) - (b.personId ? 1 : 0) || a.name.localeCompare(b.name)) };
  });
  return { asOf: today, countedInNetWorth: false,
    totals: { owed: r2(active.reduce((n, p) => n + p.owed, 0)), lent: r2(out.reduce((n, p) => n + p.lent, 0)),
      repaid: r2(out.reduce((n, p) => n + p.repaid, 0)), people: active.filter(p => p.owed > 0).length, overdue: active.filter(p => p.overdue).length,
      splits: splits.length },
    people: out, splits: splitList, suggestions: await loanSuggestions(uid, { db, people: out }) };
}

// People with both sent and received transfers that are not linked yet, plus P2P platforms (TR4-B.5).
export async function loanSuggestions(uid, { db = sql, people = [] } = {}) {
  const rows = await db.query(`SELECT t.id, t.description, t.category, t.amount::float8 AS amount, t.occurred_on::text AS day
    FROM wealth_transactions t
    WHERE t.user_id = $1 AND t.kind = 'transfer' AND t.duplicate_of IS NULL AND t.category ~* '^transfer (sent|received)$'
      AND NOT EXISTS (SELECT 1 FROM wealth_person_entries e WHERE e.transaction_id = t.id)
    ORDER BY t.occurred_on`, [uid]);
  const known = new Map(people.map(p => [p.name.toLowerCase(), p.id]));
  const by = new Map();
  for (const t of rows) {
    const person = personOf(t.description), key = person.toLowerCase();
    if (!key) continue;
    const g = by.get(key) || { person, sent: 0, received: 0, transactions: [] };
    const dir = directionOf(t);
    if (dir === 'out') g.sent += t.amount; else g.received += t.amount;
    g.transactions.push({ id: t.id, direction: dir, amount: t.amount, day: t.day });
    by.set(key, g);
  }
  return [...by.entries()]
    .map(([key, g]) => ({ ...g, key, sent: r2(g.sent), received: r2(g.received), p2p: /p2p|liquiloans|lendbox|faircent|lendenclub/i.test(key),
      personId: known.get(key) || null, firstDay: g.transactions[0].day, lastDay: g.transactions[g.transactions.length - 1].day }))
    .filter(g => (g.sent > 0 && g.received > 0) || (g.p2p && g.sent > 0))
    .sort((a, b) => (b.sent - b.received) - (a.sent - a.received))
    .slice(0, 30);
}

const rateOf = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, 'annualRate must be a percentage between 0 and 100');
  return n / 100;                         // always a percentage: 12 → 12 % a year
};
const dayOf = (v, name, now, { future = false } = {}) => {
  if (v == null || v === '') return null;
  if (!isDay(v)) throw httpError(400, `${name} must be a date (YYYY-MM-DD)`);
  if (!future && v > istToday(now)) throw httpError(400, `${name} must not be in the future`);
  return v;
};
const nameOf = v => { const n = text(v, 80); if (!n) throw httpError(400, 'A person needs a name'); return n.replace(/\s+/g, ' '); };

// Find people by id or name; names not in the list yet are added (the owner's contacts, not app users).
async function resolvePeople(db, uid, list, actor, dryRun) {
  const want = list.map((p, i) => {
    if (p?.personId != null) { if (!isUuid(p.personId)) throw httpError(400, 'personId must be a person id'); return { i, id: p.personId }; }
    return { i, name: nameOf(p?.name) };
  });
  const dup = new Set();
  for (const w of want) { const k = w.id || w.name.toLowerCase(); if (dup.has(k)) throw httpError(400, `${w.name || 'A person'} is in the list twice`); dup.add(k); }
  const ids = want.filter(w => w.id).map(w => w.id), names = want.filter(w => w.name).map(w => w.name.toLowerCase());
  const found = await db.query(`SELECT id, name FROM wealth_people WHERE user_id = $1 AND (id = ANY($2::uuid[]) OR lower(name) = ANY($3::text[]))`, [uid, ids, names]);
  const byId = new Map(found.map(p => [p.id, p])), byName = new Map(found.map(p => [p.name.toLowerCase(), p]));
  for (const w of want.filter(w => w.id)) if (!byId.has(w.id)) throw httpError(404, 'Person not found');
  const fresh = [...new Set(want.filter(w => w.name && !byName.has(w.name.toLowerCase())).map(w => w.name))];
  if (fresh.length && !dryRun) {
    const [made] = await withActor(db, actor, [[`INSERT INTO wealth_people (user_id, name) SELECT $1, n FROM unnest($2::text[]) AS n
      ON CONFLICT (user_id, lower(name)) DO NOTHING RETURNING id, name`, [uid, fresh]]]);
    for (const p of made) byName.set(p.name.toLowerCase(), p);
    const again = await db.query(`SELECT id, name FROM wealth_people WHERE user_id = $1 AND lower(name) = ANY($2::text[])`, [uid, fresh.map(n => n.toLowerCase())]);
    for (const p of again) byName.set(p.name.toLowerCase(), p);
  }
  const out = want.map(w => w.id ? byId.get(w.id) : (byName.get(w.name.toLowerCase()) || { id: null, name: w.name, isNew: true }));
  const seen = new Set();
  for (const p of out) { const k = p.id || p.name.toLowerCase(); if (seen.has(k)) throw httpError(400, `${p.name} is in the list twice`); seen.add(k); }
  return out;
}

// POST /api/loans/people {name, kind?, dueOn?, annualRate? (%), status?, note?} — add; with personId — update.
export async function savePerson(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const set = {};
  if (b?.name !== undefined) set.name = nameOf(b.name);
  if (b?.kind !== undefined) { if (!['personal', 'p2p_platform'].includes(b.kind)) throw httpError(400, 'kind must be personal or p2p_platform'); set.kind = b.kind; }
  if (b?.dueOn !== undefined) set.due_on = dayOf(b.dueOn, 'dueOn', now, { future: true });
  if (b?.annualRate !== undefined) set.annual_rate = rateOf(b.annualRate);
  if (b?.status !== undefined) { if (!['open', 'settled', 'written_off'].includes(b.status)) throw httpError(400, 'status must be open, settled or written_off'); set.status = b.status; }
  if (b?.note !== undefined) set.note = text(b.note);
  if (b?.personId == null) {
    if (!set.name) throw httpError(400, 'A person needs a name');
    if (dryRun) return { dryRun, wouldStore: set };
    const cols = Object.keys(set);
    const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_people (user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')})
      ON CONFLICT (user_id, lower(name)) DO NOTHING RETURNING id`, [uid, ...cols.map(c => set[c])]]]);
    if (!ins.length) throw httpError(409, `${set.name} is already in your people`);
    return { stored: true, personId: ins[0].id };
  }
  if (!isUuid(b.personId)) throw httpError(400, 'personId must be a person id');
  const [p] = await db.query(`SELECT id FROM wealth_people WHERE id = $1 AND user_id = $2`, [b.personId, uid]);
  if (!p) throw httpError(404, 'Person not found');
  const cols = Object.keys(set);
  if (!cols.length) throw httpError(400, 'Nothing to change');
  if (dryRun) return { dryRun, personId: p.id, wouldSet: set };
  try {
    await withActor(db, actor, [[`UPDATE wealth_people SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2`,
      [p.id, uid, ...cols.map(c => set[c])]]]);
  } catch (e) { if (e?.code === '23505') throw httpError(409, `${set.name} is already in your people`); throw e; }
  return { stored: true, personId: p.id, changed: cols };
}

// POST /api/loans/entries {personId | name, transactionIds: [] } — link transfers (sent = lent, received = paid back);
// or {personId | name, direction: out|in, amount, occurredOn?, note?} — cash / anything without a transaction.
export async function addPersonEntry(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const ids = b?.transactionIds ?? (b?.transactionId != null ? [b.transactionId] : []);
  if (!Array.isArray(ids) || ids.some(id => !isUuid(id))) throw httpError(400, 'transactionIds must be transaction ids');
  if (new Set(ids).size !== ids.length) throw httpError(400, 'transactionIds has duplicates');
  let moves;
  if (ids.length) {
    const rows = await db.query(`SELECT t.id, t.kind, t.category, t.description, t.amount::float8 AS amount, t.occurred_on::text AS day,
        EXISTS (SELECT 1 FROM wealth_person_entries e WHERE e.transaction_id = t.id) AS linked
      FROM wealth_transactions t WHERE t.user_id = $1 AND t.id = ANY($2::uuid[])`, [uid, ids]);
    if (rows.length !== ids.length) throw httpError(404, 'Transaction not found');
    for (const t of rows) {
      if (t.kind !== 'transfer') throw httpError(400, `Only transfers can be lent or paid back (${t.description || t.id} is ${t.kind}) — split a bill instead`);
      if (t.linked) throw httpError(409, `${t.description || t.id} is already linked to a person`);
    }
    moves = rows.map(t => ({ direction: ids.length === 1 && ['out', 'in'].includes(b.direction) ? b.direction : directionOf(t), amount: t.amount, on: t.day, transaction_id: t.id }));
  } else {
    if (!['out', 'in'].includes(b?.direction)) throw httpError(400, 'direction must be out (lent) or in (paid back)');
    const amount = Number(b.amount);
    if (!(amount > 0) || amount > 1e12) throw httpError(400, 'amount must be more than 0');
    moves = [{ direction: b.direction, amount: r2(amount), on: dayOf(b.occurredOn, 'occurredOn', now) || istToday(now), transaction_id: null }];
  }
  const [person] = await resolvePeople(db, uid, [b?.personId != null ? { personId: b.personId } : { name: b?.name }], actor, dryRun);
  if (dryRun) return { dryRun, person: person.name, wouldStore: moves };
  const [ins] = await withActor(db, actor, [[`INSERT INTO wealth_person_entries (person_id, direction, amount, occurred_on, transaction_id, note)
    SELECT $1, m.direction, m.amount, m.on, m.transaction_id, $3 FROM jsonb_to_recordset($2::jsonb) AS m(direction text, amount numeric, "on" date, transaction_id uuid)
    ON CONFLICT DO NOTHING RETURNING id`, [person.id, JSON.stringify(moves), text(b.note)]]]);
  if (ins.length !== moves.length) throw httpError(409, 'A transaction is already linked to a person');
  return { stored: true, personId: person.id, person: person.name, entries: ins.length };
}

// POST /api/loans/splits {transactionId?, title?, total?, tax? | taxPercent?, occurredOn?, mode: equal|amounts,
//   includeMe?: true, people: [{personId | name, base? (amount before GST, mode amounts)}], note?}
export async function createSplit(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  let title = text(b?.title, 120), total = b?.total == null || b.total === '' ? null : Number(b.total), on = dayOf(b?.occurredOn, 'occurredOn', now), txId = null;
  if (b?.transactionId != null) {
    if (!isUuid(b.transactionId)) throw httpError(400, 'transactionId must be a transaction id');
    const [t] = await db.query(`SELECT id, kind, category, description, amount::float8 AS amount, occurred_on::text AS day,
        EXISTS (SELECT 1 FROM wealth_bill_splits s WHERE s.transaction_id = t.id AND s.status = 'active') AS split
      FROM wealth_transactions t WHERE t.id = $1 AND t.user_id = $2`, [b.transactionId, uid]);
    if (!t) throw httpError(404, 'Transaction not found');
    if (!['expense', 'investment'].includes(t.kind)) throw httpError(400, 'Only a bill you paid (an expense) can be split');
    if (t.split) throw httpError(409, 'This bill is already split — cancel that split first to change it');
    if (total != null && Math.abs(total - t.amount) > 0.004) throw httpError(400, `The bill total must be the transaction amount (₹${t.amount})`);
    total = t.amount; title = title || text(t.description, 120) || t.category; on = on || t.day; txId = t.id;
  }
  if (!title) throw httpError(400, 'Give the bill a name (e.g. Dinner at Sangeetha)');
  if (!(total > 0)) throw httpError(400, 'total must be more than 0');
  let tax = b?.tax == null || b.tax === '' ? 0 : Number(b.tax);
  if (b?.taxPercent != null && b.taxPercent !== '') {
    const pct = Number(b.taxPercent);
    if (!(pct >= 0 && pct <= 100)) throw httpError(400, 'taxPercent must be between 0 and 100');
    tax = r2(total - total / (1 + pct / 100));          // GST included in the total: 18 % of ₹1,180 is ₹180
  }
  const list = Array.isArray(b?.people) ? b.people : [];
  if (list.length > 50) throw httpError(400, 'Up to 50 people per bill');
  const includeMe = b?.includeMe !== false;
  // Check the maths before adding any new person, so a refused split leaves nothing behind.
  computeShares({ total, tax, mode: b?.mode, includeMe, people: list.map((p, i) => ({ key: 'k' + i, label: p?.name, base: p?.base })) });
  const people = await resolvePeople(db, uid, list, actor, dryRun);
  const shares = computeShares({ total, tax, mode: b?.mode, includeMe, people: people.map((p, i) => ({ key: p.id || 'new:' + p.name, label: p.name, base: list[i]?.base })) });
  const named = shares.map(s => ({ ...s, name: s.key === 'me' ? 'You' : people.find(p => (p.id || 'new:' + p.name) === s.key).name, personId: s.key === 'me' ? null : s.key }));
  const othersOwe = r2(named.filter(s => s.personId).reduce((n, s) => n + s.amount, 0));
  const summary = { title, total: r2(total), tax: r2(tax), mode: b.mode, occurredOn: on || istToday(now), shares: named.map(({ key, ...s }) => s), othersOwe,
    myShare: named.find(s => s.key === 'me')?.amount ?? 0 };
  if (dryRun) return { dryRun, ...summary };
  const [ins] = await withActor(db, actor, [[`WITH s AS (
      INSERT INTO wealth_bill_splits (user_id, transaction_id, title, occurred_on, total, tax, mode, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id),
    sh AS (INSERT INTO wealth_bill_split_shares (split_id, person_id, base, tax, amount)
      SELECT s.id, x.person_id, x.base, x.tax, x.amount FROM s, jsonb_to_recordset($9::jsonb) AS x(person_id uuid, base numeric, tax numeric, amount numeric) RETURNING id)
    SELECT (SELECT id FROM s) AS id, (SELECT count(*)::int FROM sh) AS shares`,
    [uid, txId, title, summary.occurredOn, summary.total, summary.tax, b.mode, text(b.note), JSON.stringify(named.map(s => ({ person_id: s.personId, base: s.base, tax: s.tax, amount: s.amount })))]]])
    .catch(e => { if (e?.code === '23505') throw httpError(409, 'This bill is already split'); throw e; });
  return { stored: true, splitId: ins[0].id, ...summary };
}

// POST /api/loans/splits/cancel {splitId} — kept for the record, no longer counted (nothing is deleted).
export async function cancelSplit(uid, b, { db = sql, actor = 'owner', dryRun = false } = {}) {
  if (!isUuid(b?.splitId)) throw httpError(400, 'splitId must be a split id');
  const [s] = await db.query(`SELECT id, status FROM wealth_bill_splits WHERE id = $1 AND user_id = $2`, [b.splitId, uid]);
  if (!s) throw httpError(404, 'Split not found');
  if (s.status !== 'active') return { stored: false, splitId: s.id, already: 'cancelled' };
  if (dryRun) return { dryRun, splitId: s.id };
  await withActor(db, actor, [[`UPDATE wealth_bill_splits SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2`, [s.id, uid]]]);
  return { stored: true, splitId: s.id };
}
