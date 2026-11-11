// Shared, named queries (TSD §11). Handlers call these instead of repeating SQL.
import { sql } from './_lib.js';
import { splitsForAccount } from './_splits.js';

const TX_COLUMNS = `t.id,t.kind,t.category,t.description,t.amount,t.account_id,
  COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,
  to_char(t.occurred_on,'YYYY-MM-DD') AS occurred_on,
  to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key`;
// Dates and the cursor key are formatted by Postgres: no JS Date conversion (time-zone day shifts)
// and microsecond precision kept (rows created in the same millisecond are not skipped).

export const PAGE_DEFAULT = 50, PAGE_MAX = 200;

export function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify([row.occurred_on, row.created_key, row.id])).toString('base64url');
}
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [day, created, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(created) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return [day, created, id];
  } catch { return null; }
}

// Keyset pagination, newest first (TR-3.2). Stable under inserts because the key is unique.
export async function pageTransactions(uid, { cursor = null, limit = PAGE_DEFAULT } = {}, db = sql) {
  const n = Math.min(Math.max(Number(limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const after = decodeCursor(cursor);
  const rows = after
    ? await db.query(`SELECT ${TX_COLUMNS} FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id
        WHERE t.user_id=$1 AND (t.occurred_on,t.created_at,t.id) < ($2::date,$3::timestamptz,$4::uuid)
        ORDER BY t.occurred_on DESC,t.created_at DESC,t.id DESC LIMIT $5`, [uid, ...after, n])
    : await db.query(`SELECT ${TX_COLUMNS} FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id
        WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC,t.id DESC LIMIT $2`, [uid, n]);
  return { transactions: rows, nextCursor: rows.length === n ? encodeCursor(rows[rows.length - 1]) : null };
}

// Spending statistics over ALL of the user's transactions (TR-3.1), grouped small enough to send whole.
// Dates up to "today" in India, matching how the dashboard reports elapsed days.
// Transactions marked as duplicates (migration 0008, TR3-1.3) are left out.
export async function spendingRows(uid, db = sql) {
  const q = notDuplicate => db.query(`SELECT to_char(occurred_on,'YYYY-MM') AS month, kind,
      COALESCE(NULLIF(trim(category),''),'Uncategorised') AS category,
      sum(amount)::float8 AS total, count(*)::int AS n
    FROM wealth_transactions
    WHERE user_id=$1 AND occurred_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date${notDuplicate ? ' AND duplicate_of IS NULL' : ''}
    GROUP BY 1,2,3 ORDER BY 1,2,3`, [uid]);
  return q(true).catch(e => { if (e?.code === '42703') return q(false); throw e; });   // database before 0008
}

// Obligations read model (TSD Claude Plan 3, TR3-5.1): one row per obligation with its next planned occurrence and
// mandate, grouped by the paying account. The obligation id is the de-duplication key for alerts (TR3-5.3).
export async function obligationsByAccount(uid, db = sql) {
  const rows = await db.query(`SELECT o.id, o.title, o.obligation_type, o.expected_amount::float8 AS expected_amount, o.amount_type, o.frequency,
      o.status, o.source_type, o.account_id, a.bank_name, a.account_name, a.masked_identifier,
      coalesce(n.due_date, o.next_due_date)::text AS next_due_date, n.expected_amount::float8 AS next_amount, n.planned_bill_id,
      s.id AS mandate_id, s.provider_name AS mandate_provider, s.status AS mandate_status
    FROM wealth_recurring_obligations o
    LEFT JOIN wealth_accounts a ON a.user_id = o.user_id AND a.id = o.account_id
    LEFT JOIN wealth_subscriptions s ON s.user_id = o.user_id AND s.id = o.mandate_id
    LEFT JOIN LATERAL (SELECT p.due_date, p.expected_amount, p.planned_bill_id FROM wealth_payment_occurrences p
      WHERE p.obligation_id = o.id AND p.status = 'planned' ORDER BY p.due_date LIMIT 1) n ON true
    WHERE o.user_id = $1 AND o.status IN ('active', 'paused')
    ORDER BY a.bank_name NULLS LAST, a.account_name, coalesce(n.due_date, o.next_due_date) NULLS LAST, o.title`, [uid]);
  const groups = new Map();
  for (const r of rows) {
    const key = r.account_id || 'unassigned';
    if (!groups.has(key)) groups.set(key, { accountId: r.account_id, account: r.account_id ? `${r.bank_name} · ${r.account_name}${r.masked_identifier ? ' ' + r.masked_identifier : ''}` : 'No account', obligations: [] });
    groups.get(key).obligations.push(r);
  }
  return { accounts: [...groups.values()], count: rows.length };
}

function holdingRows(uid, db, withStatus) {
  return db.query(`SELECT h.account_id, h.instrument_id, i.symbol, i.name, i.asset_class, i.unit, trim(i.currency) AS currency,
      h.quantity::float8 AS quantity, h.invested_value::float8 AS invested_value,
      p.price::float8 AS price, p.as_of AS price_as_of, p.source AS price_source,
      p.fx_to_inr::float8 AS fx_to_inr, p.fetched_at
    FROM wealth_holdings h
    JOIN wealth_accounts a ON a.id = h.account_id
    JOIN wealth_instruments i ON i.id = h.instrument_id
    LEFT JOIN wealth_v_latest_prices p ON p.instrument_id = h.instrument_id
    WHERE a.user_id = $1 AND a.status = 'active'${withStatus ? " AND h.status = 'active'" : ''}
    ORDER BY i.symbol`, [uid]);
}

// Account hierarchy read model (TSD Phase 5, TR-5.3). Returns raw rows for api/_valuation.js.
export async function accountHierarchyRows(uid, db = sql) {
  const [accounts, balances, holdings, fx] = await Promise.all([
    db.query(`SELECT a.id, s.category, s.code AS subtype, s.label AS subtype_label, s.valuation, s.sort_order,
        a.bank_name AS institution, a.account_name AS name, a.masked_identifier, trim(a.currency) AS currency
      FROM wealth_accounts a JOIN wealth_account_subtypes s ON s.code = a.subtype_code
      WHERE a.user_id = $1 AND a.status = 'active'
      ORDER BY s.sort_order, a.bank_name, a.account_name`, [uid]),
    db.query(`SELECT b.account_id, b.balance::float8 AS balance, b.as_of, b.status, b.note
      FROM wealth_v_latest_balances b JOIN wealth_accounts a ON a.id = b.account_id
      WHERE a.user_id = $1`, [uid]),
    holdingRows(uid, db, true).catch(e => {
      // Database without migration 0006 (no holdings.status yet): every holding is still active.
      if (e?.code === '42703') return holdingRows(uid, db, false);
      throw e;
    }),
    db.query(`SELECT fx_to_inr::float8 AS rate, fetched_at AS as_of FROM wealth_instrument_prices
      WHERE fx_to_inr > 0 ORDER BY fetched_at DESC LIMIT 1`),
  ]);
  const moves = await cardMovesSinceBalance(uid, db).catch(() => []);
  return { accounts, balances: applyCardMoves(balances, moves), holdings, marketFx: fx[0] || null };
}

// Credit cards (2026-11-11, owner: "if i spent from card it need to add liability"): the owed amount shown is the last
// recorded balance + card movements after it — spends and investments add, cashback / refunds / bill payments on the card
// subtract. Nothing is written (rules.md §1: a transaction never changes a stored balance); the figure is marked
// "estimated" until the next recorded balance. A movement counts when its day is after the balance day, or the same day
// but entered after the balance was recorded, so nothing is counted twice.
export async function cardMovesSinceBalance(uid, db = sql) {
  return db.query(`SELECT t.account_id,
      sum(CASE WHEN t.kind IN ('expense','investment') THEN t.amount
               WHEN t.kind = 'income' THEN -t.amount
               WHEN t.kind = 'transfer' AND coalesce(t.category,'') ~* 'payment' THEN -t.amount ELSE 0 END)::float8 AS delta,
      count(*) FILTER (WHERE t.kind IN ('expense','investment'))::int AS spends,
      coalesce(sum(t.amount) FILTER (WHERE t.kind IN ('expense','investment')), 0)::float8 AS spent
    FROM wealth_transactions t
    JOIN wealth_accounts a ON a.id = t.account_id AND a.user_id = $1 AND a.subtype_code = 'credit_card'
    JOIN wealth_v_latest_balances b ON b.account_id = t.account_id
    WHERE t.user_id = $1 AND t.duplicate_of IS NULL
      AND (t.occurred_on > (b.as_of AT TIME ZONE 'Asia/Kolkata')::date
           OR (t.occurred_on = (b.as_of AT TIME ZONE 'Asia/Kolkata')::date AND t.created_at > b.as_of))
    GROUP BY t.account_id`, [uid]);
}

export function applyCardMoves(balances, moves) {
  const by = new Map(moves.filter(m => m.delta).map(m => [m.account_id, m]));
  const inr = v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return balances.map(b => {
    const m = by.get(b.account_id);
    if (!m || b.balance == null) return b;
    const recorded = Number(b.balance), est = Math.round((recorded + Number(m.delta)) * 100) / 100;
    const day = new Date(new Date(b.as_of).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    return { ...b, balance: est, status: 'estimated', recordedBalance: recorded,
      note: `${inr(recorded)} recorded ${day} ${m.delta >= 0 ? '+' : '−'} ${inr(Math.abs(m.delta))} card activity since${m.spends ? ` (${m.spends} spend${m.spends > 1 ? 's' : ''})` : ''}` };
  });
}

// v2 "add fixed deposit": account + first balance in one statement (TR-5.6). Throws 23505 on a duplicate.
export async function createFixedDepositAccount(uid, { key, institution, name, balance, note }, db = sql) {
  const rows = await db.query(
    `WITH acc AS (
        INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency,balance_status)
        VALUES($1,$2,$3,$4,'fixed_deposit','fixed_deposit','INR','unknown') RETURNING id,bank_name,account_name
      ), bal AS (
        INSERT INTO wealth_account_balances(account_id,as_of,balance,status,note)
        SELECT id,now(),$5,'reported',$6 FROM acc RETURNING account_id,as_of,balance,status,note
      )
      SELECT acc.id,acc.bank_name AS institution,acc.account_name AS name,bal.balance::float8 AS balance,bal.as_of,bal.status,bal.note
      FROM acc JOIN bal ON bal.account_id=acc.id`,
    [uid, key, institution, name, balance, note]);
  return rows[0];
}

// Mark a planned bill paid / cancelled / planned and keep its payment occurrence in step,
// in one statement (TSD TR-6.2). Returns null when the bill does not belong to the user.
export async function setBillStatus(uid, id, status, db = sql) {
  const rows = await db.query(
    `WITH b AS (
        UPDATE wealth_planned_bills SET status=$3, updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING id, status, amount
      ), o AS (
        UPDATE wealth_payment_occurrences p
        SET status = b.status,
            actual_amount = CASE WHEN b.status='paid' THEN coalesce(p.actual_amount, b.amount) ELSE NULL END,
            paid_at = CASE WHEN b.status='paid' THEN coalesce(p.paid_at, now()) ELSE NULL END,
            updated_at = now()
        FROM b WHERE p.user_id = $2
          AND (p.planned_bill_id = b.id OR (p.planned_bill_id IS NULL AND p.source_record_id = b.id))
        RETURNING p.id
      )
      SELECT b.id, b.status, (SELECT count(*) FROM o)::int AS occurrences_updated FROM b`,
    [id, uid, status]);
  return rows[0] || null;
}

// v1 (legacy) positions exactly as the live dashboard reads them; shared with /api/reconcile.
export async function legacyPositionRows(uid, db = sql){
 const enrichedQuery=`SELECT p.id,p.category,p.institution_name,p.platform_name,p.record_type,p.name,p.ticker,p.currency,p.quantity,
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND a.asset_class IN ('indian_equity','indian_mutual_fund','us_equity','us_etf','precious_metal') AND mp.currency=p.currency AND p.quantity IS NOT NULL THEN p.quantity*mp.unit_price ELSE p.current_value END AS current_value,
  p.invested_value,p.balance_as_of,p.source_key,p.metadata,mp.unit_price AS market_unit_price,mp.currency AS market_price_currency,
  mp.source AS market_price_source,mp.fetched_at AS market_price_updated_at,mp.status AS market_price_status,a.quantity_unit,
  (mp.metadata->>'fx_to_inr')::numeric AS market_fx_to_inr,
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND p.quantity IS NOT NULL
   THEN CASE WHEN mp.currency='USD' THEN p.quantity*mp.unit_price*NULLIF(CASE WHEN NULLIF(mp.metadata->>'fx_to_inr','')::numeric>0 AND NULLIF(mp.metadata->>'fx_as_of','')::timestamptz>now()-interval '36 hours' THEN NULLIF(mp.metadata->>'fx_to_inr','')::numeric ELSE NULL END,0)
             WHEN mp.currency='INR' THEN p.quantity*mp.unit_price ELSE NULL END ELSE NULL END AS market_value_inr%PREV_COLS%
  FROM wealth_positions p
  LEFT JOIN wealth_investment_assets a ON a.position_id=p.id
  LEFT JOIN wealth_market_prices mp ON mp.asset_id=a.id%PREV_JOIN%
  WHERE p.user_id=$1 AND p.record_type NOT LIKE '%_ARCHIVED' ORDER BY p.category,p.platform_name,p.record_type,p.name`;
 // Day change (2026-11-11): the previous close is the last stored price from before the latest price's IST trading day
 // (wealth_instrument_prices keeps every quote whoever wrote it, through the 0006 mirror trigger). Holidays and weekends
 // are handled naturally: after the 10 Nov holiday the previous close is the 9 Nov price.
 const prevCols=`,mp.source_timestamp AS market_price_as_of,pc.price AS market_previous_close,pc.as_of AS market_previous_close_at`;
 const prevJoin=`
  LEFT JOIN wealth_instruments ins ON ins.asset_class=a.asset_class
   AND ins.symbol=coalesce(p.ticker,CASE WHEN a.asset_class='precious_metal' THEN upper(p.record_type) ELSE p.name END)
  LEFT JOIN LATERAL (SELECT ip.price,ip.as_of FROM wealth_instrument_prices ip
   WHERE ip.instrument_id=ins.id AND mp.source_timestamp IS NOT NULL
     AND ip.as_of < (date_trunc('day',mp.source_timestamp AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
   ORDER BY ip.as_of DESC,ip.fetched_at DESC LIMIT 1) pc ON true`;
 try{
  return await db.query(enrichedQuery.replace('%PREV_COLS%',prevCols).replace('%PREV_JOIN%',prevJoin),[uid]);
 }catch(error){
  console.error('[wealth-dashboard:previous-close]',error?.message||error);
 }
 try{
  return await db.query(enrichedQuery.replace('%PREV_COLS%','').replace('%PREV_JOIN%',''),[uid]);
 }catch(error){
  console.error('[wealth-dashboard:priced-positions]',error?.message||error);
  // A missing pricing table must never hide the user's saved positions or turn totals into zero.
  return await db.query(`SELECT id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,
   current_value,invested_value,balance_as_of,source_key,metadata,
   NULL::numeric AS market_unit_price,NULL::char(3) AS market_price_currency,
   NULL::text AS market_price_source,NULL::timestamptz AS market_price_updated_at,
   NULL::text AS market_price_status,NULL::text AS quantity_unit,
   NULL::numeric AS market_fx_to_inr,NULL::numeric AS market_value_inr
   FROM wealth_positions WHERE user_id=$1 AND record_type NOT LIKE '%_ARCHIVED'
   ORDER BY category,platform_name,record_type,name`,[uid]);
 }
}

export function legacyAccountRows(uid, db = sql) {
  return db.query(`SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name`, [uid]);
}

// One account's detail page, entirely from the tables (no imported snapshots): the account, its balance history,
// this month's money in/out, interest (if linked), upcoming payments from it and recent transactions.
// Returns null when the account does not belong to the user.
export async function accountDetail(uid, accountId, db = sql, { now = Date.now(), txLimit = 25 } = {}) {
  const [acc] = await db.query(`SELECT a.id, a.account_key, a.bank_name, a.account_name, a.masked_identifier, a.account_type, a.subtype_code,
      trim(a.currency) AS currency, a.current_balance::float8 AS current_balance, a.balance_as_of, a.balance_status, s.label AS subtype_label, s.category
    FROM wealth_accounts a LEFT JOIN wealth_account_subtypes s ON s.code = a.subtype_code WHERE a.user_id = $1 AND a.id = $2`, [uid, accountId]);
  if (!acc) return null;
  const month = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 7);
  const notDup = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='wealth_transactions' AND column_name='duplicate_of'`).then(r => r.length ? ' AND t.duplicate_of IS NULL' : '');
  const [history, flows, transactions, interest, upcoming, counts] = await Promise.all([
    db.query(`SELECT as_of, balance::float8 AS balance, status, note FROM wealth_account_balances WHERE account_id = $1 ORDER BY as_of DESC LIMIT 30`, [acc.id]),
    db.query(`SELECT to_char(t.occurred_on, 'YYYY-MM') AS month, t.kind, sum(t.amount)::float8 AS total, count(*)::int AS n
      FROM wealth_transactions t WHERE t.user_id = $1 AND t.account_id = $2${notDup} AND t.occurred_on >= (date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date) - interval '5 months')
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [uid, acc.id]),
    db.query(`SELECT t.id, to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on, t.kind, t.category, t.description, t.amount::float8 AS amount, t.external_ref
      FROM wealth_transactions t WHERE t.user_id = $1 AND t.account_id = $2${notDup} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT $3`, [uid, acc.id, txLimit]),
    db.query(`SELECT p.product_key, p.provider,
        (SELECT annual_rate::float8 FROM wealth_interest_rates r WHERE r.product_key = p.product_key AND r.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS rate,
        (SELECT effective_from::text FROM wealth_interest_rates r WHERE r.product_key = p.product_key AND r.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS rate_from,
        (SELECT max(accrual_date)::text FROM wealth_interest_ledger g WHERE g.user_id = $1 AND g.account_key = $3 AND g.product_key = p.product_key) AS last_accrual,
        (SELECT coalesce(sum(interest_amount), 0)::float8 FROM wealth_interest_ledger g WHERE g.user_id = $1 AND g.account_key = $3 AND g.product_key = p.product_key
           AND to_char(accrual_date, 'YYYY-MM') = $4) AS accrued_month,
        st.statement_total::float8 AS statement_total, st.period_end::text AS statement_end,
        (SELECT coalesce(sum(interest_amount), 0)::float8 FROM wealth_interest_ledger g WHERE g.user_id = $1 AND g.account_key = $3 AND g.product_key = p.product_key
           AND to_char(accrual_date, 'YYYY-MM') = $4 AND accrual_date > st.period_end) AS accrued_after_statement
      FROM wealth_interest_links l JOIN wealth_interest_products p ON p.id = l.product_id
      LEFT JOIN LATERAL (SELECT statement_total, period_end FROM wealth_interest_statements s WHERE s.user_id = $1 AND s.product_key = p.product_key
        AND to_char(s.period_end, 'YYYY-MM') = $4 ORDER BY s.period_end DESC LIMIT 1) st ON true
      WHERE l.account_id = $2`, [uid, acc.id, acc.account_key, month]).catch(() => []),
    db.query(`SELECT o.id, o.title, o.obligation_type, o.frequency, coalesce(n.due_date, o.next_due_date)::text AS due_date,
        coalesce(n.expected_amount, o.expected_amount)::float8 AS amount, o.amount_type
      FROM wealth_recurring_obligations o
      LEFT JOIN LATERAL (SELECT p.due_date, p.expected_amount FROM wealth_payment_occurrences p WHERE p.obligation_id = o.id AND p.status = 'planned' ORDER BY p.due_date LIMIT 1) n ON true
      WHERE o.user_id = $1 AND o.account_id = $2 AND o.status = 'active' ORDER BY 5 NULLS LAST, o.title`, [uid, acc.id]).catch(() => []),
    db.query(`SELECT count(*)::int AS n FROM wealth_transactions t WHERE t.user_id = $1 AND t.account_id = $2${notDup}`, [uid, acc.id]),
  ]);
  // Month-to-date interest, same rule as the Interest page: bank statement through its end date + daily accruals after.
  for (const i of interest) {
    i.month_total = Math.round((i.statement_total != null ? i.statement_total + (i.accrued_after_statement || 0) : i.accrued_month) * 100) / 100;
    i.month_basis = i.statement_total != null ? `statement to ${i.statement_end} + daily accruals after` : 'daily accruals';
  }
  const IN = ['income'], OUT = ['expense', 'investment', 'liability'];
  const sum = (m, kinds) => flows.filter(f => f.month === m && kinds.includes(f.kind)).reduce((s, f) => s + f.total, 0);
  const months = [...new Set(flows.map(f => f.month))].sort().reverse().map(m => ({ month: m, moneyIn: sum(m, IN), moneyOut: sum(m, OUT), transfers: sum(m, ['transfer']) }));
  return { account: acc, month, thisMonth: months.find(m => m.month === month) || { month, moneyIn: 0, moneyOut: 0, transfers: 0 }, months,
    balanceHistory: history, interest, upcoming, transactions, transactionCount: counts[0]?.n || 0,
    // Splits inside this account (0019), e.g. Atom → Rent; never part of totals.
    splits: await splitsForAccount(uid, accountId, { db }).catch(() => []) };
}
