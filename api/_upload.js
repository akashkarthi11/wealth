import { sql, withActor } from './_lib.js';
import { createAccount, recordBalance } from './_ingest.js';
import { addPersonEntry } from './_loans.js';

// Upload (2026-11-12). A signed-in user uploads one Excel file with up to four sheets - Transactions, Accounts, Lending,
// Investments - and everything is saved against that user only. The whole file is checked first: one bad row in any sheet
// rejects the upload with sheet + row numbers, so nothing is half-saved by a typo. Rows that already exist are skipped.
// Order of saving: accounts, then transactions (which may name a new account), lending, investments.
export const KINDS = ['income', 'expense', 'transfer', 'investment', 'liability'];
export const MAX_ROWS = 500;
const INVEST_TYPES = { equity: { record: 'EQUITY', cls: 'indian_equity', unit: 'share' }, mutual_fund: { record: 'MUTUAL_FUND', cls: 'indian_mutual_fund', unit: 'unit' }, gold: { record: 'GOLD', cls: 'precious_metal', unit: 'g' } };
export const INVEST_KEYS = Object.keys(INVEST_TYPES);
const err = (status, message, details) => Object.assign(new Error(message), { status, details });
const isDate = s => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = v => Number(String(v ?? '').replace(/,/g, '').trim());
const str = v => String(v ?? '').trim();
const maxDay = now => new Date(now + 864e5).toISOString().slice(0, 10);

// ---- Transactions ----------------------------------------------------------------------------------------------------
async function accountMap(db, uid) {
  const accounts = await db.query('SELECT id, account_name, account_key FROM wealth_accounts WHERE user_id=$1', [uid]);
  const m = new Map();
  for (const a of accounts) { m.set(String(a.account_name || '').toLowerCase(), a.id); m.set(String(a.account_key || '').toLowerCase(), a.id); }
  return m;
}

export async function prepareTransactions(uid, rows, { db = sql, now = Date.now(), extraNames = new Set() } = {}) {
  const byName = await accountMap(db, uid);
  const limit = maxDay(now), clean = [], problems = [];
  rows.forEach((r, i) => {
    const row = i + 2, bad = m => problems.push({ sheet: 'Transactions', row, error: m });
    const kind = str(r.type ?? r.kind).toLowerCase(), category = str(r.category), description = str(r.description);
    const amount = num(r.amount), date = str(r.date), accountName = str(r.account), ref = str(r.reference);
    if (!KINDS.includes(kind)) return bad('Type must be one of ' + KINDS.join(', '));
    if (!category || category.length > 60) return bad('Category is required (60 characters at most)');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return bad('Amount must be a number above 0');
    if (!isDate(date)) return bad('Date must be YYYY-MM-DD');
    if (date > limit) return bad('Date is in the future');
    if (description.length > 180) return bad('Description is longer than 180 characters');
    if (ref.length > 120) return bad('Reference is longer than 120 characters');
    if (accountName && !byName.has(accountName.toLowerCase()) && !extraNames.has(accountName.toLowerCase())) return bad('Account "' + accountName.slice(0, 40) + '" is not one of your accounts');
    clean.push({ kind, category, description, amount: Math.round(amount * 100) / 100, date, accountName, ref: ref || null });
  });
  return { clean, problems };
}

export async function saveTransactions(uid, clean, { db = sql } = {}) {
  if (!clean.length) return { added: 0, skipped: 0 };
  const byName = await accountMap(db, uid);
  const dates = clean.map(c => c.date).sort();
  const existing = await db.query(
    `SELECT occurred_on::text AS d, amount::float8 AS a, kind, lower(description) AS t, external_ref FROM wealth_transactions
     WHERE user_id=$1 AND (occurred_on BETWEEN $2 AND $3 OR external_ref = ANY($4::text[]))`, [uid, dates[0], dates[dates.length - 1], clean.map(c => c.ref).filter(Boolean)]);
  const seenKey = new Set(existing.map(e => [e.d, e.a, e.kind, e.t].join('|')));
  const seenRef = new Set(existing.map(e => e.external_ref).filter(Boolean));
  const fresh = []; let skipped = 0;
  for (const c of clean) {
    const key = [c.date, c.amount, c.kind, c.description.toLowerCase()].join('|');
    if ((c.ref && seenRef.has(c.ref)) || seenKey.has(key)) { skipped++; continue; }
    seenKey.add(key); if (c.ref) seenRef.add(c.ref);
    fresh.push({ ...c, accountId: c.accountName ? byName.get(c.accountName.toLowerCase()) || null : null });
  }
  if (fresh.length) {
    await db.query(
      `INSERT INTO wealth_transactions(user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref)
       SELECT $1::uuid, k, c, d, a, '', acc, o::date, ref FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::uuid[], $7::text[], $8::text[]) AS t(k, c, d, a, acc, o, ref)`,
      [uid, fresh.map(f => f.kind), fresh.map(f => f.category), fresh.map(f => f.description), fresh.map(f => f.amount), fresh.map(f => f.accountId), fresh.map(f => f.date), fresh.map(f => f.ref)]);
  }
  return { added: fresh.length, skipped };
}

// Kept for the single-sheet case (CSV): validate + save.
export async function importTransactions(uid, rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) throw err(400, 'The file has no transaction rows.');
  if (rows.length > MAX_ROWS) throw err(400, 'At most ' + MAX_ROWS + ' rows per upload.');
  const { clean, problems } = await prepareTransactions(uid, rows, opts);
  if (problems.length) throw err(400, problems.length + ' row' + (problems.length === 1 ? '' : 's') + ' need fixing. Nothing was uploaded.', problems.slice(0, 50));
  const r = await saveTransactions(uid, clean, opts);
  return { received: rows.length, ...r };
}

// ---- Accounts --------------------------------------------------------------------------------------------------------
async function prepareAccounts(rows, { db, now }) {
  const subs = await db.query('SELECT code, valuation FROM wealth_account_subtypes');
  const val = new Map(subs.map(s => [s.code, s.valuation]));
  const clean = [], problems = [], seen = new Set(), seenDigits = new Set(), limit = maxDay(now);
  rows.forEach((r, i) => {
    const row = i + 2, bad = m => problems.push({ sheet: 'Accounts', row, error: m });
    const type = str(r.type).toLowerCase().replace(/[\s-]+/g, '_'), institution = str(r.institution), name = str(r.name), digits = str(r.digits), currency = str(r.currency).toUpperCase();
    const hasBal = str(r.balance) !== '', asOf = str(r.asOf);
    if (!val.has(type)) return bad('Type must be one of ' + [...val.keys()].join(', '));
    if (!institution || institution.length > 80) return bad('Institution is required (80 characters at most)');
    if (!name || name.length > 80) return bad('Account name is required (80 characters at most)');
    if (digits.length > 20) return bad('Last digits must be 20 characters at most');
    if (currency && !['INR', 'USD'].includes(currency)) return bad('Currency must be INR or USD');
    let balance = null;
    if (hasBal) {
      if (val.get(type) !== 'balance') return bad('Opening balance applies only to bank, deposit, provident fund and liability accounts');
      balance = num(r.balance);
      if (!Number.isFinite(balance) || balance < 0 || balance > 1e12) return bad('Opening balance must be a number, 0 or more (for a card or loan, the amount you owe)');
    }
    if (asOf && (!isDate(asOf) || asOf > limit)) return bad('Balance date must be YYYY-MM-DD, not in the future');
    if (digits && seenDigits.has(slug(institution) + '|' + slug(digits))) return bad('Another account in the sheet has the same institution and last digits');
    if (digits) seenDigits.add(slug(institution) + '|' + slug(digits));
    const key = [slug(institution), type, slug(name), digits ? slug(digits) : ''].join('|');
    if (seen.has(key)) return bad('This account appears twice in the sheet');
    seen.add(key);
    clean.push({ type, institution, name, digits: digits || null, currency: currency || undefined, balance, asOf: asOf || null });
  });
  return { clean, problems };
}

async function saveAccounts(uid, clean, { db, actor, now }) {
  let added = 0, skipped = 0;
  for (const c of clean) {
    let created;
    try { created = await createAccount(uid, { subtype: c.type, institution: c.institution, name: c.name, maskedIdentifier: c.digits, currency: c.currency }, { db, actor }); }
    catch (e) { if (e?.status === 409 || e?.code === '23505') { skipped++; continue; } throw e; }
    added++;
    if (c.balance !== null) await recordBalance(uid, { accountId: created.account.id, balance: c.balance, asOf: c.asOf ? c.asOf + 'T00:00:00Z' : new Date(now).toISOString(), status: 'reported', note: 'Entered in upload' }, { db, actor, now });
  }
  return { added, skipped };
}

// ---- Lending ---------------------------------------------------------------------------------------------------------
const OUT = ['lent', 'out', 'gave', 'paid for'], IN = ['paid back', 'received', 'in', 'repaid', 'returned'];
function prepareLending(rows, { now }) {
  const clean = [], problems = [], limit = maxDay(now);
  rows.forEach((r, i) => {
    const row = i + 2, bad = m => problems.push({ sheet: 'Lending', row, error: m });
    const person = str(r.person).replace(/\s+/g, ' '), d = str(r.direction).toLowerCase(), amount = num(r.amount), date = str(r.date), note = str(r.note);
    const direction = OUT.includes(d) ? 'out' : IN.includes(d) ? 'in' : null;
    if (!person || person.length > 60) return bad('Person is required (60 characters at most)');
    if (!direction) return bad('Direction must be "lent" (you gave money) or "paid back" (they returned money)');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return bad('Amount must be a number above 0');
    if (!isDate(date) || date > limit) return bad('Date must be YYYY-MM-DD, not in the future');
    if (note.length > 120) return bad('Note is longer than 120 characters');
    clean.push({ person, direction, amount: Math.round(amount * 100) / 100, date, note });
  });
  return { clean, problems };
}

async function saveLending(uid, clean, { db, actor, now }) {
  const existing = await db.query(`SELECT lower(p.name) AS n, e.direction AS d, e.amount::float8 AS a, e.occurred_on::text AS o, coalesce(e.note,'') AS t
    FROM wealth_person_entries e JOIN wealth_people p ON p.id = e.person_id WHERE p.user_id = $1`, [uid]);
  const seen = new Set(existing.map(e => [e.n, e.d, e.a, e.o, e.t.toLowerCase()].join('|')));
  let added = 0, skipped = 0;
  for (const c of clean) {
    const key = [c.person.toLowerCase(), c.direction, c.amount, c.date, c.note.toLowerCase()].join('|');
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    await addPersonEntry(uid, { name: c.person, direction: c.direction, amount: c.amount, occurredOn: c.date, note: c.note || null }, { db, actor, now });
    added++;
  }
  return { added, skipped };
}

// ---- Investments (INR) -----------------------------------------------------------------------------------------------
function prepareInvestments(rows) {
  const clean = [], problems = [], seen = new Set();
  rows.forEach((r, i) => {
    const row = i + 2, bad = m => problems.push({ sheet: 'Investments', row, error: m });
    const type = str(r.type).toLowerCase().replace(/[\s-]+/g, '_'), platform = str(r.platform), name = str(r.name), symbol = str(r.symbol);
    const quantity = num(r.quantity), invested = num(r.invested), current = num(r.current);
    if (!INVEST_TYPES[type]) return bad('Type must be one of ' + INVEST_KEYS.join(', '));
    if (!platform || platform.length > 80) return bad('Platform is required (80 characters at most)');
    if (!name || name.length > 120) return bad('Name is required (120 characters at most)');
    if (symbol.length > 40) return bad('Symbol is longer than 40 characters');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e12) return bad('Quantity must be a number above 0');
    if (!Number.isFinite(invested) || invested < 0 || invested > 1e12) return bad('Invested amount must be a number, 0 or more');
    if (!Number.isFinite(current) || current <= 0 || current > 1e12) return bad('Current value must be a number above 0');
    const key = 'upload:' + slug(platform) + ':' + slug(name);
    if (seen.has(key)) return bad('This holding appears twice in the sheet');
    seen.add(key);
    clean.push({ type, platform, name, symbol: symbol || null, quantity, invested, current, key });
  });
  return { clean, problems };
}

async function saveInvestments(uid, clean, { db, actor, now }) {
  const existing = new Set((await db.query(`SELECT source_key FROM wealth_positions WHERE user_id=$1 AND source_key = ANY($2::text[])`, [uid, clean.map(c => c.key)])).map(r => r.source_key));
  let added = 0, skipped = 0;
  for (const c of clean) {
    if (existing.has(c.key)) { skipped++; continue; }
    const t = INVEST_TYPES[c.type], id = globalThis.crypto.randomUUID();
    await withActor(db, actor, [
      [`INSERT INTO wealth_positions (id, user_id, category, institution_name, platform_name, record_type, name, ticker, currency, quantity, current_value, invested_value, balance_as_of, source_key, metadata)
        VALUES ($1,$2,'INVESTMENT',$3,$3,$4,$5,$6,'INR',$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`, [id, uid, c.platform, t.record, c.name, c.symbol, c.quantity, c.current, c.invested, new Date(now).toISOString(), c.key, JSON.stringify({ source: 'upload' })]],
      [`INSERT INTO wealth_investment_assets (user_id, position_id, asset_class, symbol, display_name, quantity_unit, price_currency, pricing_status)
        VALUES ($1,$2,$3,$4,$5,$6,'INR','manual') RETURNING id`, [uid, id, t.cls, c.symbol || c.name, c.name, t.unit]],
    ]);
    added++;
  }
  return { added, skipped };
}

// ---- Whole file ------------------------------------------------------------------------------------------------------
export async function importAll(uid, sets, { db = sql, now = Date.now(), actor = 'user' } = {}) {
  const tx = sets.transactions || [], ac = sets.accounts || [], le = sets.lending || [], inv = sets.investments || [];
  if (![tx, ac, le, inv].every(Array.isArray)) throw err(400, 'Upload data is not valid.');
  if (!tx.length && !ac.length && !le.length && !inv.length) throw err(400, 'The file has no rows to upload.');
  for (const [n, a, cap] of [['Transactions', tx, MAX_ROWS], ['Accounts', ac, 50], ['Lending', le, 50], ['Investments', inv, 50]]) if (a.length > cap) throw err(400, n + ': at most ' + cap + ' rows per upload - this sheet has ' + a.length + '.');
  const A = await prepareAccounts(ac, { db, now });
  const extraNames = new Set(A.clean.map(c => c.name.toLowerCase()));
  const T = await prepareTransactions(uid, tx, { db, now, extraNames });
  const L = prepareLending(le, { now });
  const I = prepareInvestments(inv);
  const problems = [...A.problems, ...T.problems, ...L.problems, ...I.problems];
  if (problems.length) throw err(400, problems.length + ' row' + (problems.length === 1 ? '' : 's') + ' need fixing. Nothing was uploaded.', problems.slice(0, 50));
  const out = {};
  out.accounts = await saveAccounts(uid, A.clean, { db, actor, now });
  out.transactions = await saveTransactions(uid, T.clean, { db });
  out.lending = await saveLending(uid, L.clean, { db, actor, now });
  out.investments = await saveInvestments(uid, I.clean, { db, actor, now });
  const added = Object.values(out).reduce((s, x) => s + x.added, 0), skipped = Object.values(out).reduce((s, x) => s + x.skipped, 0);
  return { ...out, added, skipped };
}
