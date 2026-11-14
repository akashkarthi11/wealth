import { sql, withActor, isUuid, httpError } from './_lib.js';

// Balance review (0028, owner 2026-11-14): a balance the assistant saved from a screenshot is 'reported', not verified. It is
// listed in Data quality until the owner confirms it (becomes verified) or rejects it (the previous balance is used again; the
// rejected row is kept, never deleted).
export async function unconfirmedBalances(uid, { db = sql } = {}) {
  const rows = await db.query(`SELECT a.id AS account_id, a.bank_name, a.account_name, a.masked_identifier, b.as_of, b.balance::float8 AS balance,
      p.balance::float8 AS prev_balance, p.as_of AS prev_as_of, p.status AS prev_status
    FROM wealth_accounts a
    JOIN LATERAL (SELECT as_of, balance, status, entered_by, confirmed_at FROM wealth_account_balances WHERE account_id = a.id AND rejected_at IS NULL ORDER BY as_of DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT as_of, balance, status FROM wealth_account_balances x WHERE x.account_id = a.id AND x.rejected_at IS NULL AND x.as_of < b.as_of ORDER BY x.as_of DESC LIMIT 1) p ON true
    WHERE a.user_id = $1 AND b.entered_by = 'agent' AND b.status = 'reported' AND b.confirmed_at IS NULL
    ORDER BY b.as_of DESC`, [uid]);
  return rows.map(r => ({ accountId: r.account_id, name: [r.bank_name, r.account_name].filter(Boolean).join(' · ') + (r.masked_identifier ? ' ' + r.masked_identifier : ''),
    asOf: new Date(r.as_of).toISOString(), balance: r.balance, previous: r.prev_as_of ? { balance: r.prev_balance, asOf: new Date(r.prev_as_of).toISOString(), status: r.prev_status } : null }));
}

async function find(db, uid, accountId, asOf) {
  if (!isUuid(accountId)) throw httpError(400, 'accountId must be an account id');
  if (!Number.isFinite(Date.parse(asOf))) throw httpError(400, 'asOf must be a date-time');
  const [r] = await db.query(`SELECT b.as_of FROM wealth_account_balances b JOIN wealth_accounts a ON a.id=b.account_id AND a.user_id=$1
    WHERE b.account_id=$2 AND b.as_of=$3::timestamptz AND b.entered_by='agent' AND b.status='reported' AND b.confirmed_at IS NULL AND b.rejected_at IS NULL`, [uid, accountId, asOf]);
  if (!r) throw httpError(404, 'This balance is not waiting for review.');
}

export async function confirmBalance(uid, { accountId, asOf }, { db = sql, actor = 'owner' } = {}) {
  await find(db, uid, accountId, asOf);
  await withActor(db, actor, [
    [`UPDATE wealth_account_balances SET status='verified', confirmed_at=now(), confirmed_by=$3 WHERE account_id=$1 AND as_of=$2::timestamptz RETURNING as_of`, [accountId, asOf, actor]],
    [`UPDATE wealth_accounts SET balance_status='verified', updated_at=now() WHERE id=$1 AND user_id=$3 AND balance_as_of=$2::timestamptz AND subtype_code IN ('savings','current') RETURNING id`, [accountId, asOf, uid]],
  ]);
  return { confirmed: true };
}

export async function rejectBalance(uid, { accountId, asOf, reason }, { db = sql, actor = 'owner' } = {}) {
  await find(db, uid, accountId, asOf);
  await withActor(db, actor, [
    [`UPDATE wealth_account_balances SET rejected_at=now(), rejected_by=$3, rejected_reason=$4 WHERE account_id=$1 AND as_of=$2::timestamptz RETURNING as_of`,
      [accountId, asOf, actor, String(reason || '').trim().slice(0, 200) || null]],
    // Bank accounts are also shown by the legacy dashboard: put the previous balance back there.
    [`UPDATE wealth_accounts a SET current_balance=p.balance, balance_as_of=p.as_of, balance_status=CASE WHEN p.status='verified' THEN 'verified' ELSE 'stale' END, updated_at=now()
      FROM wealth_v_latest_balances p WHERE a.id=$1 AND a.user_id=$3 AND p.account_id=a.id AND a.subtype_code IN ('savings','current') AND a.balance_as_of=$2::timestamptz RETURNING a.id`, [accountId, asOf, uid]],
  ]);
  return { rejected: true };
}
