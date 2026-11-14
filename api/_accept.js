import { sql, withActor, isUuid, httpError } from './_lib.js';
import { activeOffersFor, matchOffers, applyOffers, rewardState } from './_offers.js';

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
  const { offers, uses, programs } = await activeOffersFor(uid, [...new Set(rows.map(r => r.account_id))], { db });
  return rows.map(r => {
    const d = signedDelta({ acctCategory: r.acct_category, valuation: r.valuation, kind: r.kind, category: r.category, amount: r.amount });
    const can = d.delta != null && r.balance != null;
    const pendOffers = matchOffers(offers, r, uses, programs);
    return {
      id: r.id, kind: r.kind, category: r.category, description: r.description, amount: r.amount, date: r.occurred_on, accountId: r.account_id,
      account: [r.bank_name, r.account_name].filter(Boolean).join(' · ') + (r.masked_identifier ? ' ' + r.masked_identifier : ''),
      balance: r.balance, delta: d.delta, after: can ? r2(r.balance + d.delta) : null,
      cannot: d.delta == null ? d.reason : r.balance == null ? 'Record a balance for this account first, then accept.' : null,
      owes: r.acct_category === 'LIABILITY', offers: pendOffers, rewardState: rewardState(pendOffers),
    };
  });
}

// Cashback that an offer earns goes into the history at once (owner rule 2026-11-14): an income transaction "Cashback" on the same account,
// and the account balance moves with it (a card's amount owed goes down). The earning is marked received and linked to that transaction.
// Points need no transaction: they are added to their reward program by the earning itself. Discounts and coupons are not money received.
async function postCashback(uid, t, earning, { db, actor, now }) {
  const amount = r2(Number(earning.inr));
  if (!(amount > 0)) return null;
  // The account that receives it: the one chosen for this reward, else the payment's own account.
  const toId = earning.receiveAccountId || t.account_id;
  let dest = { acct_category: t.acct_category, valuation: t.valuation };
  if (toId !== t.account_id) {
    [dest] = await db.query(`SELECT s.category AS acct_category, s.valuation FROM wealth_accounts a JOIN wealth_account_subtypes s ON s.code = a.subtype_code WHERE a.id = $1 AND a.user_id = $2`, [toId, uid]);
    if (!dest) return null;
  }
  const at = new Date(now).toISOString(), ref = 'reward:' + earning.id, day = String(t.occurred_on).slice(0, 10);
  const d = signedDelta({ acctCategory: dest.acct_category, valuation: dest.valuation, kind: 'income', category: 'Cashback', amount });
  const paidOn = toId !== t.account_id ? ' · paid on ' + [t.bank_name, t.account_name].filter(Boolean).join(' ') : '';
  const desc = ('Cashback · ' + (earning.title || 'offer') + ' · ' + (t.description || t.category) + paidOn).slice(0, 180);
  const note = 'Cashback: ' + String(earning.title || 'offer').slice(0, 60) + ' on ' + String(t.description || t.category).slice(0, 50) + (d.delta == null ? '' : ' (' + (d.delta >= 0 ? '+' : '-') + Math.abs(d.delta) + ')');
  const [ins, bal] = await withActor(db, actor, [
    [`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref, review_status, reviewed_at, applied_balance_as_of)
      VALUES ($1,'income','Cashback',$2,$3,'',$4,$5::date,$6,'accepted',$7::timestamptz,$7::timestamptz)
      ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`, [uid, desc, amount, toId, day, ref, at]],
    d.delta == null ? ['SELECT 1 WHERE false', []] : [`WITH cur AS (SELECT balance, as_of FROM wealth_v_latest_balances WHERE account_id=$1)
      INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note, entered_by)
      SELECT $1, greatest($4::timestamptz, cur.as_of + interval '1 second'), round(cur.balance + $5::numeric, 2), 'reported', $6, 'accept' FROM cur
      WHERE EXISTS (SELECT 1 FROM wealth_transactions WHERE user_id=$2 AND external_ref=$3 AND applied_balance_as_of=$4::timestamptz)
      RETURNING balance::float8 AS balance`, [toId, uid, ref, at, d.delta, note]],
    [`UPDATE wealth_accounts SET current_balance=(SELECT balance FROM wealth_v_latest_balances WHERE account_id=$1),
        balance_as_of=(SELECT as_of FROM wealth_v_latest_balances WHERE account_id=$1), balance_status='stale', updated_at=now()
      WHERE id=$1 AND user_id=$2 AND subtype_code IN ('savings','current')
        AND EXISTS (SELECT 1 FROM wealth_transactions WHERE user_id=$2 AND external_ref=$3 AND applied_balance_as_of=$4::timestamptz) RETURNING id`, [toId, uid, ref, at]],
  ]);
  if (!ins.length) return null;
  await db.query(`UPDATE wealth_offer_uses SET status='received', credited_transaction_id=$3, credited_on=$4::date, receive_account_id=$5, updated_at=now() WHERE id=$1 AND user_id=$2`, [earning.id, uid, ins[0].id, day, toId]);
  return { earningId: earning.id, transactionId: ins[0].id, accountId: toId, amount, balance: bal && bal[0] ? bal[0].balance : null };
}
const postCashbacks = async (uid, t, applied, o) => { const out = []; for (const e of applied) if (e.kind === 'cashback' && e.inr > 0) { const r = await postCashback(uid, t, { id: e.id, title: e.title, inr: e.inr, receiveAccountId: e.receiveAccountId }, o); if (r) out.push(r); } return out; };

export async function acceptTransaction(uid, { transactionId, applyOfferIds, usedOfferIds, receive } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
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
  // Rewards: the offers of this account that match are applied now (the automatic ones, or exactly the ones the owner left switched on).
  // A failure here never undoes the accepted balance; the owner can apply the offers again from the transaction.
  let offerResult = { applied: [], matched: [] }, offerError = null;
  try { offerResult = await applyOffers(uid, t, Array.isArray(applyOfferIds) ? applyOfferIds : Array.isArray(usedOfferIds) ? usedOfferIds : undefined, { db, actor, receive }); }
  catch (e) { offerError = e?.message || 'Offers could not be applied.'; }
  let cashbackPosted = [];
  try { cashbackPosted = await postCashbacks(uid, t, offerResult.applied, { db, actor, now }); }
  catch (e) { offerError = offerError || 'The cashback could not be added to the history: ' + (e?.message || 'error'); }
  return { accepted: true, before: t.balance, delta: d.delta, after: ins[0].balance, offers: offerResult.matched, applied: offerResult.applied, cashbackPosted, rewardState: offerResult.state || 'none', needsChoice: offerResult.state === 'choose' && !offerResult.applied.length, offerError };
}

// Work out and apply the offers of a payment that was already accepted (or any past payment out): for a payment accepted before the
// offer existed, or when the owner switched an offer off and wants it back. Offers already applied to the payment are left as they are.
export async function applyOffersToTransaction(uid, { transactionId, applyOfferIds, receive } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(transactionId)) throw httpError(400, 'transactionId must be a transaction id');
  const [t] = await db.query(`${SELECT} WHERE t.user_id = $1 AND t.id = $2`, [uid, transactionId]);
  if (!t) throw httpError(404, 'Transaction not found (it needs an account)');
  const [state] = await db.query('SELECT review_status, duplicate_of FROM wealth_transactions WHERE id=$1 AND user_id=$2', [transactionId, uid]);
  if (state.duplicate_of || state.review_status === 'dismissed') throw httpError(409, 'Offers are not applied to a duplicate or dismissed transaction.');
  if (state.review_status === 'pending') throw httpError(409, 'Accept the transaction first; offers are applied when it is accepted.');
  const r = await applyOffers(uid, t, Array.isArray(applyOfferIds) ? applyOfferIds : undefined, { db, actor, receive });
  const cashbackPosted = await postCashbacks(uid, t, r.applied, { db, actor, now });
  return { offers: r.matched, applied: r.applied, cashbackPosted, rewardState: r.state };
}

export async function dismissTransaction(uid, { transactionId } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(transactionId)) throw httpError(400, 'transactionId must be a transaction id');
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_transactions SET review_status='dismissed', reviewed_at=$3::timestamptz
    WHERE id=$1 AND user_id=$2 AND review_status='pending' RETURNING id`, [transactionId, uid, new Date(now).toISOString()]]]);
  if (!rows.length) throw httpError(404, 'This transaction is not waiting for review.');
  return { dismissed: true };
}

// Change the account that receives a cashback. If the app already wrote the cashback to the history, that entry moves to the new account:
// the old account's balance is put back and the new account's balance takes it (new balance rows, nothing overwritten).
export async function changeReceiveAccount(uid, { earningId, accountId } = {}, { db = sql, actor = 'user', now = Date.now() } = {}) {
  if (!isUuid(earningId) || !isUuid(accountId)) throw httpError(400, 'earningId and accountId must be ids');
  const [e] = await db.query(`SELECT id, kind, status, title FROM wealth_offer_uses WHERE id=$1 AND user_id=$2`, [earningId, uid]);
  if (!e) throw httpError(404, 'Reward not found');
  if (e.kind !== 'cashback') throw httpError(400, 'Only cashback is received in an account. Points go to their reward program.');
  if (e.status === 'cancelled') throw httpError(409, 'This reward was removed.');
  const [dest] = await db.query(`SELECT s.category AS acct_category, s.valuation FROM wealth_accounts a JOIN wealth_account_subtypes s ON s.code = a.subtype_code WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'active' AND s.valuation = 'balance' AND s.category IN ('CASA', 'LIABILITY')`, [accountId, uid]);
  if (!dest) throw httpError(400, 'Choose one of your cash or card accounts.');
  const ref = 'reward:' + earningId;
  const [h] = await db.query(`SELECT t.id, t.account_id, t.amount::float8 AS amount, s.category AS acct_category, s.valuation FROM wealth_transactions t JOIN wealth_accounts a ON a.id = t.account_id JOIN wealth_account_subtypes s ON s.code = a.subtype_code WHERE t.user_id = $1 AND t.external_ref = $2`, [uid, ref]);
  if (!h) {   // not in the history (an older, expected cashback): only remember where it will be credited
    await db.query(`UPDATE wealth_offer_uses SET receive_account_id=$3, updated_at=now() WHERE id=$1 AND user_id=$2`, [earningId, uid, accountId]);
    return { changed: true, moved: false };
  }
  if (h.account_id === accountId) return { changed: false, moved: false };
  const back = signedDelta({ acctCategory: h.acct_category, valuation: h.valuation, kind: 'income', category: 'Cashback', amount: h.amount });
  const gain = signedDelta({ acctCategory: dest.acct_category, valuation: dest.valuation, kind: 'income', category: 'Cashback', amount: h.amount });
  const at = new Date(now).toISOString(), note = 'Cashback moved: ' + String(e.title || 'offer').slice(0, 60);
  const move = (account, delta) => [`WITH cur AS (SELECT balance, as_of FROM wealth_v_latest_balances WHERE account_id=$1)
      INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note, entered_by)
      SELECT $1, greatest($4::timestamptz, cur.as_of + interval '1 second'), round(cur.balance + $5::numeric, 2), 'reported', $6, 'accept' FROM cur
      WHERE EXISTS (SELECT 1 FROM wealth_transactions WHERE id=$2 AND user_id=$3 AND account_id=$7 AND applied_balance_as_of=$4::timestamptz)
      RETURNING balance::float8 AS balance`, [account, h.id, uid, at, delta, note, accountId]];
  const legacy = account => [`UPDATE wealth_accounts SET current_balance=(SELECT balance FROM wealth_v_latest_balances WHERE account_id=$1),
        balance_as_of=(SELECT as_of FROM wealth_v_latest_balances WHERE account_id=$1), balance_status='stale', updated_at=now()
      WHERE id=$1 AND user_id=$2 AND subtype_code IN ('savings','current')
        AND EXISTS (SELECT 1 FROM wealth_transactions WHERE id=$3 AND user_id=$2 AND account_id=$5 AND applied_balance_as_of=$4::timestamptz) RETURNING id`, [account, uid, h.id, at, accountId]];
  const [moved] = await withActor(db, actor, [
    [`UPDATE wealth_transactions SET account_id=$3, applied_balance_as_of=$4::timestamptz WHERE id=$1 AND user_id=$2 AND account_id=$5 RETURNING id`, [h.id, uid, accountId, at, h.account_id]],
    move(h.account_id, -back.delta), move(accountId, gain.delta), legacy(h.account_id), legacy(accountId),
    [`UPDATE wealth_offer_uses SET receive_account_id=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id`, [earningId, uid, accountId]],
  ]);
  if (!moved.length) throw httpError(409, 'This cashback was just changed. Reload and try again.');
  return { changed: true, moved: true, transactionId: h.id };
}
