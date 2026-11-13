import { sql, withActor, isUuid, httpError } from './_lib.js';
import { activeOffersFor, matchOffers, recordOfferUses } from './_offers.js';

// Accept a transaction (0029, owner 2026-11-14). New transactions wait as 'pending'. Accept writes a new balance on the source
// account (last balance plus or minus the amount, status 'reported', entered_by 'accept') and shows the account's offers that
// match the payee. Dismiss keeps the transaction but leaves the balance alone.
const r2 = n => Math.round(n * 100) / 100;

// Which way does this transaction move the account's balance? null + reason when it cannot be decided automatically.
export function signedDelta({ acctCategory, valuation, kind, category, amount }) {
  if (valuation !== 'balance') return { delta: null, reason: 'This account type has no balance to change. Dismiss it, or assign another account.' };
  const a = Number(amount);
  if (acctCategory === 'LIABILITY') {                       // balance = amount owed
    if (kind === 'expense' || kind === 'investment') return { delta: a };
    if (kind === 'income' || kind === 'liability') return { delta: -a };
    if (kind === 'transfer' && /payment/i.test(String(category || ''))) return { delta: -a };
    return { delta: null, reason: 'This transfer cannot change a card or loan balance automatically. Dismiss it.' };
  }
  if (kind === 'income') return { delta: a };
  if (kind === 'expense' || kind === 'investment' || kind === 'liability') return { delta: -a };
  if (kind === 'transfer') return { delta: /received|from/i.test(String(category || '')) ? a : -a };
  return { delta: null, reason: 'Unknown transaction type.' };
}

const SELECT = `SELECT t.id, t.kind, t.category, t.description, t.amount::float8 AS amount, t.occurred_on::text AS occurred_on, t.account_id,
    a.bank_name, a.account_name, a.masked_identifier, a.subtype_code, s.category AS acct_category, s.valuation,
    b.balance::float8 AS balance, b.as_of
  FROM wealth_transactions t
  JOIN wealth_accounts a ON a.id = t.account_id AND a.user_id = $1
  JOIN wealth_account_subtypes s ON s.code = a.subtype_code
  LEFT JOIN wealth_v_latest_balances b ON b.account_id = a.id`;

export async function pendingTransactions(uid, { db = sql } = {}) {
  const rows = await db.query(`${SELECT} WHERE t.user_id = $1 AND t.review_status = 'pending' AND t.duplicate_of IS NULL
    ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 100`, [uid]);
  const { offers, uses } = await activeOffersFor(uid, [...new Set(rows.map(r => r.account_id))], { db });
  return rows.map(r => {
    const d = signedDelta({ acctCategory: r.acct_category, valuation: r.valuation, kind: r.kind, category: r.category, amount: r.amount });
    const can = d.delta != null && r.balance != null;
    return {
      id: r.id, kind: r.kind, category: r.category, description: r.description, amount: r.amount, date: r.occurred_on, accountId: r.account_id,
      account: [r.bank_name, r.account_name].filter(Boolean).join(' · ') + (r.masked_identifier ? ' ' + r.masked_identifier : ''),
      balance: r.balance, delta: d.delta, after: can ? r2(r.balance + d.delta) : null,
      cannot: d.delta == null ? d.reason : r.balance == null ? 'Record a balance for this account first, then accept.' : null,
      owes: r.acct_category === 'LIABILITY', offers: matchOffers(offers, r, uses),
    };
  });
}

export async function acceptTransaction(uid, { transactionId, usedOfferIds = [] } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(transactionId)) throw httpError(400, 'transactionId must be a transaction id');
  const [t] = await db.query(`${SELECT} WHERE t.user_id = $1 AND t.id = $2`, [uid, transactionId]);
  if (!t) throw httpError(404, 'Transaction not found');
  const [state] = await db.query('SELECT review_status, duplicate_of FROM wealth_transactions WHERE id=$1 AND user_id=$2', [transactionId, uid]);
  if (state.review_status !== 'pending' || state.duplicate_of) throw httpError(409, 'This transaction is not waiting for review.');
  const d = signedDelta({ acctCategory: t.acct_category, valuation: t.valuation, kind: t.kind, category: t.category, amount: t.amount });
  if (d.delta == null) throw httpError(400, d.reason);
  if (t.balance == null) throw httpError(409, 'Record a balance for this account first, then accept.');
  const at = new Date(now).toISOString();
  const note = `Accepted: ${String(t.description || t.category).slice(0, 80)} (${d.delta >= 0 ? '+' : '-'}${Math.abs(d.delta)})`;
  const [ins] = await withActor(db, actor, [
    [`WITH upd AS (UPDATE wealth_transactions SET review_status='accepted', reviewed_at=$4::timestamptz, applied_balance_as_of=$4::timestamptz
         WHERE id=$1 AND user_id=$2 AND review_status='pending' RETURNING id),
       cur AS (SELECT balance, as_of FROM wealth_v_latest_balances WHERE account_id=$3)
     INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note, entered_by)
     SELECT $3, greatest($4::timestamptz, cur.as_of + interval '1 second'), round(cur.balance + $5::numeric, 2), 'reported', $6, 'accept' FROM upd, cur
     RETURNING balance::float8 AS balance, as_of`, [transactionId, uid, t.account_id, at, d.delta, note]],
    [`UPDATE wealth_accounts SET current_balance=(SELECT balance FROM wealth_v_latest_balances WHERE account_id=$1),
        balance_as_of=(SELECT as_of FROM wealth_v_latest_balances WHERE account_id=$1), balance_status='stale', updated_at=now()
      WHERE id=$1 AND user_id=$2 AND subtype_code IN ('savings','current')
        AND EXISTS (SELECT 1 FROM wealth_transactions WHERE id=$3 AND review_status='accepted' AND reviewed_at=$4::timestamptz) RETURNING id`, [t.account_id, uid, transactionId, at]],
  ]);
  if (!ins.length) throw httpError(409, 'This transaction was already handled.');
  const { offers: all, uses } = await activeOffersFor(uid, [t.account_id], { db });
  const offers = matchOffers(all, t, uses);
  const usedOffers = await recordOfferUses(uid, t, usedOfferIds, { db });
  return { accepted: true, before: t.balance, delta: d.delta, after: ins[0].balance, offers, usedOffers };
}

export async function dismissTransaction(uid, { transactionId } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(transactionId)) throw httpError(400, 'transactionId must be a transaction id');
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_transactions SET review_status='dismissed', reviewed_at=$3::timestamptz
    WHERE id=$1 AND user_id=$2 AND review_status='pending' RETURNING id`, [transactionId, uid, new Date(now).toISOString()]]]);
  if (!rows.length) throw httpError(404, 'This transaction is not waiting for review.');
  return { dismissed: true };
}
