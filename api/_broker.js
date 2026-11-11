// Broker funds ledger (migration 0011, 2026-11-11): import a broker statement as history, match "funds added"
// entries to the bank-side transactions, and summarise money put in, withdrawn and broker charges.
import { sql, withActor } from './_lib.js';

// Kind of an entry, from the type the broker prints (Angel One wording).
export function ledgerKind(type, { debit = 0, credit = 0 } = {}) {
  const t = String(type || '').trim().toLowerCase();
  if (/^funds added/.test(t)) return 'funds_added';
  if (/^funds withdrawn|^quarterly settlement/.test(t)) return 'funds_withdrawn';   // settlement returns unused funds to the bank
  if (/^trades executed|^mtf (buy|sell|position closure)/.test(t)) return 'trade';
  if (/^cash to mtf|^mtf to cash/.test(t)) return 'mtf_transfer';
  if (/charge|reversal|reversed|interest/.test(t)) return 'charge';                  // reversals are credits against charges
  return Number(credit) > 0 && !Number(debit) ? 'credit_other' : 'charge';
}

const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const label = (rows, key) => { for (const r of rows) { const i = r.indexOf(key); if (i >= 0 && r[i + 1] !== undefined && r[i + 1] !== '') return r[i + 1]; } return null; };

// rows: one sheet as arrays of cell strings. Checks the entries add up to the printed totals.
export function parseLedgerSheet(rows, ledger) {
  const head = rows.findIndex(r => r[0] === 'Transaction' && r[1] === 'Date');
  if (head < 0) throw new Error(`${ledger} ledger: header row "Transaction | Date" not found`);
  const entries = rows.slice(head + 1).filter(r => /^\d{4}-\d{2}-\d{2}/.test(String(r[1] || ''))).map(r => {
    const debit = num(r[4]), credit = num(r[5]);
    return { ledger, entry_type: String(r[0]).trim(), entry_date: String(r[1]).slice(0, 10), segment: r[2] || null, voucher: String(r[3] || '').trim(),
      debit, credit, running_balance: r[6] === undefined || r[6] === '' ? null : num(r[6]), kind: ledgerKind(r[0], { debit, credit }) };
  });
  const totals = { credit: num(label(rows, 'Total Credit')), debit: num(label(rows, 'Total Debit')), closing: num(label(rows, 'Closing Balance')) };
  const sum = k => Math.round(entries.reduce((n, e) => n + e[k], 0) * 100) / 100;
  if (sum('credit') !== totals.credit || sum('debit') !== totals.debit) throw new Error(`${ledger} ledger: entries (credit ${sum('credit')}, debit ${sum('debit')}) do not match the printed totals (${totals.credit}, ${totals.debit})`);
  if (Math.round((sum('credit') - sum('debit')) * 100) / 100 !== totals.closing) throw new Error(`${ledger} ledger: closing balance ${totals.closing} does not match the entries`);
  if (entries.some(e => !e.voucher)) throw new Error(`${ledger} ledger: an entry has no voucher`);
  return { entries, totals, period: { from: label(rows, 'StartDate'), to: label(rows, 'EndDate') } };
}

// Adds entries that are not stored yet (unique per voucher + type + date + amounts). Returns counts.
export async function importBrokerLedger(uid, { broker, accountId = null, source, entries }, { db = sql, dryRun = false } = {}) {
  if (!entries?.length) return { inserted: 0, existing: 0 };
  const payload = JSON.stringify(entries.map(e => ({ ...e, user_id: uid, account_id: accountId, broker, source })));
  if (dryRun) {
    const [r] = await db.query(`SELECT count(*)::int AS existing FROM jsonb_to_recordset($1::jsonb) AS x(user_id uuid, broker text, ledger text, voucher text, entry_type text, entry_date date, debit numeric, credit numeric)
      JOIN wealth_broker_ledger l USING (user_id, broker, ledger, voucher, entry_type, entry_date, debit, credit)`, [payload]);
    return { inserted: entries.length - r.existing, existing: r.existing, dryRun: true };
  }
  const rows = await db.query(`INSERT INTO wealth_broker_ledger (user_id, account_id, broker, ledger, entry_date, entry_type, kind, segment, voucher, debit, credit, running_balance, source)
    SELECT user_id, account_id, broker, ledger, entry_date, entry_type, kind, segment, voucher, debit, credit, running_balance, source
    FROM jsonb_to_recordset($1::jsonb) AS x(user_id uuid, account_id uuid, broker text, ledger text, entry_date date, entry_type text, kind text,
      segment text, voucher text, debit numeric, credit numeric, running_balance numeric, source text)
    ON CONFLICT ON CONSTRAINT wealth_broker_ledger_entry_key DO NOTHING RETURNING id`, [payload]);
  return { inserted: rows.length, existing: entries.length - rows.length };
}

// Links each unmatched "funds added" entry to the bank-side transaction with the same amount, a description naming
// the broker, within 3 days (closest date first). Transactions still marked "pending" / "verify" get a clear category.
export async function matchBrokerFunds(uid, { broker = 'angel_one', namePattern = '%angel%', category = 'Funds added to Angel One', db = sql, dryRun = false, actor = 'owner' } = {}) {
  const funds = await db.query(`SELECT id, entry_date::text AS d, credit::float8 AS amount FROM wealth_broker_ledger
    WHERE user_id=$1 AND broker=$2 AND ledger='broking' AND kind='funds_added' AND matched_transaction_id IS NULL ORDER BY entry_date`, [uid, broker]);
  if (!funds.length) return { matched: [], unmatched: 0 };
  const txs = await db.query(`SELECT t.id, t.occurred_on::text AS d, t.amount::float8 AS amount, t.category FROM wealth_transactions t
    WHERE t.user_id=$1 AND t.kind IN ('investment','transfer') AND (t.description ILIKE $2 OR t.category ILIKE $2)
      AND NOT EXISTS (SELECT 1 FROM wealth_broker_ledger l WHERE l.matched_transaction_id=t.id)`, [uid, namePattern]);
  const used = new Set(), matched = [], days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  for (const f of funds) {
    const c = txs.filter(t => !used.has(t.id) && Math.abs(t.amount - f.amount) < 0.005 && days(t.d, f.d) <= 3).sort((a, b) => days(a.d, f.d) - days(b.d, f.d))[0];
    if (c) { used.add(c.id); matched.push({ ledgerId: f.id, transactionId: c.id, date: f.d, amount: f.amount, recategorise: /pending|verify/i.test(c.category || '') }); }
  }
  if (!dryRun && matched.length) {
    await withActor(db, actor, matched.flatMap(m => [
      [`UPDATE wealth_broker_ledger SET matched_transaction_id=$2 WHERE id=$1 AND matched_transaction_id IS NULL`, [m.ledgerId, m.transactionId]],
      ...(m.recategorise ? [[`UPDATE wealth_transactions SET category=$3 WHERE id=$1 AND user_id=$2`, [m.transactionId, uid, category]]] : []),
    ]));
  }
  const firstTx = txs.map(t => t.d).sort()[0] || null;
  return { matched, unmatched: funds.filter(f => !matched.some(m => m.ledgerId === f.id) && firstTx && f.d >= firstTx).length };
}

// Per broker: money put in, withdrawn, charges (lifetime and this year), cash at the broker, MTF balance, by year.
export async function brokerSummary(uid, db = sql) {
  const rows = await db.query(`SELECT broker,
      coalesce(sum(credit) FILTER (WHERE ledger='broking' AND kind='funds_added'),0)::float8 AS added,
      coalesce(sum(debit) FILTER (WHERE ledger='broking' AND kind='funds_withdrawn'),0)::float8 AS withdrawn,
      coalesce(sum(debit-credit) FILTER (WHERE ledger='broking' AND kind='charge'),0)::float8 AS charges,
      coalesce(sum(debit-credit) FILTER (WHERE ledger='broking' AND kind='charge' AND entry_date >= date_trunc('year', current_date)),0)::float8 AS charges_year,
      coalesce(sum(credit-debit) FILTER (WHERE ledger='broking'),0)::float8 AS cash,
      coalesce(sum(credit-debit) FILTER (WHERE ledger='mtf'),0)::float8 AS mtf_balance,
      max(entry_date) FILTER (WHERE ledger='mtf')::text AS mtf_last,
      min(entry_date) FILTER (WHERE ledger='broking')::text AS first, max(entry_date) FILTER (WHERE ledger='broking')::text AS last,
      count(*) FILTER (WHERE kind='funds_added' AND matched_transaction_id IS NOT NULL)::int AS matched
    FROM wealth_broker_ledger WHERE user_id=$1 GROUP BY broker ORDER BY broker`, [uid]);
  if (!rows.length) return [];
  const years = await db.query(`SELECT broker, extract(year FROM entry_date)::int AS year,
      coalesce(sum(credit) FILTER (WHERE kind='funds_added'),0)::float8 AS added,
      coalesce(sum(debit) FILTER (WHERE kind='funds_withdrawn'),0)::float8 AS withdrawn,
      coalesce(sum(debit-credit) FILTER (WHERE kind='charge'),0)::float8 AS charges
    FROM wealth_broker_ledger WHERE user_id=$1 AND ledger='broking' GROUP BY 1,2 ORDER BY 1,2`, [uid]);
  const r2 = n => Math.round(n * 100) / 100;
  return rows.map(r => ({ broker: r.broker, added: r2(r.added), withdrawn: r2(r.withdrawn), netPutIn: r2(r.added - r.withdrawn), charges: r2(r.charges), chargesThisYear: r2(r.charges_year),
    cash: r2(r.cash), mtfBalance: r2(r.mtf_balance), mtfLast: r.mtf_last, first: r.first, last: r.last, matchedTransfers: r.matched,
    years: years.filter(y => y.broker === r.broker).map(y => ({ year: y.year, added: r2(y.added), withdrawn: r2(y.withdrawn), charges: r2(y.charges) })) }));
}
