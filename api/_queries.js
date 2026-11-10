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
