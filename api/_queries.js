// Shared, named queries (TSD §11). Handlers call these instead of repeating SQL.
import { sql } from './_lib.js';

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
export async function spendingRows(uid, db = sql) {
  return db.query(`SELECT to_char(occurred_on,'YYYY-MM') AS month, kind,
      COALESCE(NULLIF(trim(category),''),'Uncategorised') AS category,
      sum(amount)::float8 AS total, count(*)::int AS n
    FROM wealth_transactions
    WHERE user_id=$1 AND occurred_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date
    GROUP BY 1,2,3 ORDER BY 1,2,3`, [uid]);
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
  return { accounts, balances, holdings, marketFx: fx[0] || null };
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
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND a.asset_class IN ('indian_equity','indian_mutual_fund','us_equity','us_etf') AND mp.currency=p.currency AND p.quantity IS NOT NULL THEN p.quantity*mp.unit_price ELSE p.current_value END AS current_value,
  p.invested_value,p.balance_as_of,p.source_key,p.metadata,mp.unit_price AS market_unit_price,mp.currency AS market_price_currency,
  mp.source AS market_price_source,mp.fetched_at AS market_price_updated_at,mp.status AS market_price_status,a.quantity_unit,
  (mp.metadata->>'fx_to_inr')::numeric AS market_fx_to_inr,
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND p.quantity IS NOT NULL
   THEN CASE WHEN mp.currency='USD' THEN p.quantity*mp.unit_price*NULLIF(CASE WHEN NULLIF(mp.metadata->>'fx_to_inr','')::numeric>0 AND NULLIF(mp.metadata->>'fx_as_of','')::timestamptz>now()-interval '36 hours' THEN NULLIF(mp.metadata->>'fx_to_inr','')::numeric ELSE NULL END,0)
             WHEN mp.currency='INR' THEN p.quantity*mp.unit_price ELSE NULL END ELSE NULL END AS market_value_inr
  FROM wealth_positions p
  LEFT JOIN wealth_investment_assets a ON a.position_id=p.id
  LEFT JOIN wealth_market_prices mp ON mp.asset_id=a.id
  WHERE p.user_id=$1 AND p.record_type NOT LIKE '%_ARCHIVED' ORDER BY p.category,p.platform_name,p.record_type,p.name`;
 try{
  return await db.query(enrichedQuery,[uid]);
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
