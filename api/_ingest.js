// Validated write APIs for scheduled agents and the owner (TSD Claude Plan 3, Phase 2 and Phase 1 corrections).
// The app owns validation, de-duplication and storage; agents only send what they found. Every write runs in one
// transaction with the audit actor set (withActor). Nothing here deletes a row: corrections update or append.
import { sql, withActor, httpError, isUuid, isDay } from './_lib.js';
import { LIVE_SOURCES } from './_valuation.js';

const ASSET_CLASSES = ['indian_equity', 'indian_mutual_fund', 'us_equity', 'us_etf', 'precious_metal'];
const FUTURE_SLACK_MS = 10 * 60 * 1000;
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const when = v => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t) : null; };
const notFuture = (d, now) => d && d.getTime() <= now + FUTURE_SLACK_MS;

// ── TR3-2.1 POST /api/prices ───────────────────────────────────────────────────────────────────────────────────
export function checkPriceItem(it, now = Date.now()) {
  if (!it || typeof it !== 'object') return 'item must be an object';
  if (!ASSET_CLASSES.includes(it.assetClass)) return 'unknown assetClass';
  if (!it.symbol || String(it.symbol).length > 120) return 'symbol required (max 120)';
  const price = num(it.price);
  if (!(price > 0) || price > 1e9) return 'price must be a positive number';
  if (!['INR', 'USD'].includes(it.currency)) return 'currency must be INR or USD';
  const asOf = when(it.asOf);
  if (!asOf) return 'asOf must be a date-time';
  if (!notFuture(asOf, now)) return 'asOf is in the future';
  if (!LIVE_SOURCES.has(it.source)) return 'source is not one of the accepted live sources';
  if (it.currency === 'USD' && !(num(it.fxToInr) > 0)) return 'USD prices need fxToInr';
  return null;
}

export async function storePrices(uid, items, { db = sql, actor = 'agent', dryRun = false, now = Date.now() } = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw httpError(400, 'items must be an array of 1–200 prices');
  const results = [];
  for (const it of items) {
    const key = `${it?.assetClass}:${it?.symbol}`;
    const problem = checkPriceItem(it, now);
    if (problem) { results.push({ key, status: 'rejected', reason: problem }); continue; }
    const [ins] = await db.query(`SELECT id, trim(currency) AS currency, price_hold_reason FROM wealth_instruments
      WHERE asset_class=$1 AND (symbol=$2 OR price_source_symbol=$2) ORDER BY (symbol=$2) DESC LIMIT 1`, [it.assetClass, String(it.symbol)]);
    if (!ins) { results.push({ key, status: 'rejected', reason: 'unknown instrument' }); continue; }
    if (ins.currency !== it.currency) { results.push({ key, status: 'rejected', reason: `instrument is priced in ${ins.currency}` }); continue; }
    if (ins.price_hold_reason) { results.push({ key, status: 'on_hold', reason: ins.price_hold_reason }); continue; }
    const asOf = when(it.asOf).toISOString();
    const [latest] = await db.query(`SELECT as_of, source FROM wealth_v_latest_prices WHERE instrument_id=$1`, [ins.id]);
    if (latest) {
      const t = new Date(latest.as_of).getTime(), mine = Date.parse(asOf);
      if (t === mine && latest.source === it.source) { results.push({ key, status: 'already_stored' }); continue; }
      if (t >= mine) { results.push({ key, status: 'older_than_latest', reason: `latest is ${new Date(t).toISOString()}` }); continue; }
    }
    if (dryRun) { results.push({ key, status: 'would_store' }); continue; }
    const fx = it.currency === 'USD' ? num(it.fxToInr) : null;
    const meta = JSON.stringify({ fx_to_inr: fx, fx_as_of: fx ? asOf : null, provider_symbol: String(it.symbol), pricing_basis: 'ingest api' });
    const [v2, legacy] = await withActor(db, actor, [
      [`INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr, fetched_at)
        VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (instrument_id, as_of, source) DO NOTHING RETURNING instrument_id`,
        [ins.id, asOf, it.source, num(it.price), fx]],
      // Legacy table (until Plan 2 Phase F): every live position of this user that maps to the instrument.
      [`WITH assets AS (
          SELECT ia.id, ia.user_id FROM wealth_investment_assets ia
          JOIN wealth_positions p ON p.id = ia.position_id
          JOIN wealth_instruments i ON i.asset_class = ia.asset_class
           AND i.symbol = coalesce(p.ticker, CASE WHEN ia.asset_class = 'precious_metal' THEN upper(p.record_type) ELSE p.name END)
          WHERE i.id = $1 AND p.user_id = $2 AND p.record_type NOT LIKE '%_ARCHIVED'
        ), up AS (
          INSERT INTO wealth_market_prices (asset_id, user_id, unit_price, currency, source, source_timestamp, fetched_at, status, metadata)
          SELECT id, user_id, $3, $4, $5, $6, now(), 'fresh', $7::jsonb FROM assets
          ON CONFLICT (asset_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, currency = EXCLUDED.currency, source = EXCLUDED.source,
            source_timestamp = EXCLUDED.source_timestamp, fetched_at = now(), status = 'fresh', metadata = EXCLUDED.metadata
          WHERE wealth_market_prices.source_timestamp IS NULL OR EXCLUDED.source_timestamp > wealth_market_prices.source_timestamp
          RETURNING asset_id
        )
        INSERT INTO wealth_price_history (asset_id, user_id, unit_price, currency, source, source_timestamp, metadata)
        SELECT a.id, a.user_id, $3, $4, $5, $6, $7::jsonb FROM assets a WHERE a.id IN (SELECT asset_id FROM up)
        RETURNING asset_id`,
        [ins.id, uid, num(it.price), it.currency, it.source, asOf, meta]],
    ]);
    results.push({ key, status: v2.length ? 'stored' : 'already_stored', legacyRows: legacy.length });
  }
  return { dryRun, results };
}

// ── TR3-2.2 / TR3-2.3 Gmail imports ───────────────────────────────────────────────────────────────────────────
const KINDS = ['income', 'expense', 'transfer', 'investment', 'liability'];
const CASH_SUBTYPES = ['savings', 'current', 'credit_card'];

export async function seenMessages(uid, ids, { db = sql } = {}) {
  const list = [...new Set(String(ids || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!list.length || list.length > 500 || list.some(s => s.length > 200)) throw httpError(400, 'ids: 1–500 comma-separated message ids');
  const rows = await db.query(`SELECT message_id FROM wealth_email_imports WHERE user_id=$1 AND provider='gmail' AND message_id = ANY($2::text[])`, [uid, list]);
  return { seen: rows.map(r => r.message_id) };
}

export async function recordEmailImport(uid, b, { db = sql, actor = 'agent', dryRun = false } = {}) {
  const messageId = String(b?.messageId || '').trim();
  if (!messageId || messageId.length > 200) throw httpError(400, 'messageId required (max 200)');
  const outcome = String(b?.outcome || '');
  if (!['import', 'ignored', 'needs_review'].includes(outcome)) throw httpError(400, 'outcome must be import, ignored or needs_review');
  const [existing] = await db.query(`SELECT import_status, transaction_id FROM wealth_email_imports WHERE user_id=$1 AND provider='gmail' AND message_id=$2`, [uid, messageId]);
  if (existing) return { status: 200, body: { messageId, result: 'already_recorded', importStatus: existing.import_status, transactionId: existing.transaction_id } };

  if (outcome !== 'import') {
    if (dryRun) return { status: 200, body: { messageId, result: 'would_record', importStatus: outcome } };
    await withActor(db, actor, [[`INSERT INTO wealth_email_imports (user_id, provider, message_id, transaction_id, import_status)
      VALUES ($1,'gmail',$2,NULL,$3) ON CONFLICT (user_id, provider, message_id) DO NOTHING`, [uid, messageId, outcome]]]);
    return { status: 201, body: { messageId, result: 'recorded', importStatus: outcome } };
  }

  const txs = Array.isArray(b.transactions) ? b.transactions : [];
  if (!txs.length || txs.length > 20) throw httpError(400, 'import needs 1–20 transactions');
  for (const t of txs) {
    const amount = num(t?.amount);
    if (!KINDS.includes(t?.kind) || !String(t?.category || '').trim() || !(amount > 0) || amount > 1e12 || !isDay(t?.occurredOn) || !isUuid(t?.accountId))
      throw httpError(400, 'each transaction needs kind, category, amount > 0, occurredOn (YYYY-MM-DD) and accountId');
  }
  const accountIds = [...new Set(txs.map(t => t.accountId))];
  const ok = await db.query(`SELECT id FROM wealth_accounts WHERE user_id=$1 AND id = ANY($2::uuid[]) AND status='active' AND subtype_code = ANY($3::text[])`,
    [uid, accountIds, CASH_SUBTYPES]);
  if (ok.length !== accountIds.length) throw httpError(400, 'accountId must be one of your active savings, current or credit-card accounts');

  const outcomes = [];
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i], ref = 'gmail:' + messageId + (txs.length > 1 ? ':' + (i + 1) : '');
    const [byRef] = await db.query(`SELECT id FROM wealth_transactions WHERE user_id=$1 AND external_ref=$2`, [uid, ref]);
    if (byRef) { outcomes.push({ ref, result: 'matched_existing', transactionId: byRef.id }); continue; }
    // Same movement imported earlier without a reference.
    const [same] = await db.query(`SELECT id FROM wealth_transactions WHERE user_id=$1 AND account_id=$2 AND occurred_on=$3 AND amount=$4 AND kind=$5
      AND external_ref IS NULL ORDER BY created_at LIMIT 1`, [uid, t.accountId, t.occurredOn, num(t.amount), t.kind]);
    if (same) { outcomes.push({ ref, result: 'matched_existing', transactionId: same.id }); continue; }
    if (dryRun) { outcomes.push({ ref, result: 'would_import' }); continue; }
    const [rows] = await withActor(db, actor, [[`INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on, external_ref)
      VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8) ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
      [uid, t.kind, String(t.category).trim().slice(0, 60), String(t.description || '').slice(0, 180), num(t.amount), t.accountId, t.occurredOn, ref]]]);
    if (rows.length) outcomes.push({ ref, result: 'imported', transactionId: rows[0].id });
    else outcomes.push({ ref, result: 'matched_existing', transactionId: (await db.query(`SELECT id FROM wealth_transactions WHERE user_id=$1 AND external_ref=$2`, [uid, ref]))[0]?.id || null });
  }
  if (dryRun) return { status: 200, body: { messageId, result: 'dry_run', transactions: outcomes } };
  const importStatus = outcomes.some(o => o.result === 'imported') ? 'imported' : 'matched_existing';
  await withActor(db, actor, [[`INSERT INTO wealth_email_imports (user_id, provider, message_id, transaction_id, import_status)
    VALUES ($1,'gmail',$2,$3,$4) ON CONFLICT (user_id, provider, message_id) DO NOTHING`, [uid, messageId, outcomes[0].transactionId, importStatus]]]);
  return { status: 201, body: { messageId, result: 'recorded', importStatus, transactions: outcomes } };
}

// ── TR3-2.4 Balances, holdings, accounts ──────────────────────────────────────────────────────────────────────
async function ownAccount(db, uid, accountId) {
  if (!isUuid(accountId)) throw httpError(400, 'accountId must be a uuid');
  const [a] = await db.query(`SELECT a.id, a.account_key, a.subtype_code, a.status, s.valuation, s.category
    FROM wealth_accounts a LEFT JOIN wealth_account_subtypes s ON s.code = a.subtype_code WHERE a.user_id=$1 AND a.id=$2`, [uid, accountId]);
  if (!a) throw httpError(404, 'Account not found');
  return a;
}

export async function recordBalance(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const a = await ownAccount(db, uid, b?.accountId);
  if (a.status !== 'active' || a.valuation !== 'balance') throw httpError(400, 'Balances are recorded only on active cash, deposit, provident-fund or liability accounts');
  const balance = num(b.balance), asOf = when(b.asOf || new Date(now).toISOString()), status = String(b.status || 'verified');
  if (!Number.isFinite(balance) || Math.abs(balance) > 1e12) throw httpError(400, 'balance must be a number');
  if (!notFuture(asOf, now)) throw httpError(400, 'asOf must be a date-time, not in the future');
  if (!['verified', 'reported', 'pending_reconciliation'].includes(status)) throw httpError(400, 'status must be verified, reported or pending_reconciliation');
  const note = b.note ? String(b.note).slice(0, 300) : null;
  if (dryRun) return { dryRun, accountId: a.id, wouldStore: { balance, asOf: asOf.toISOString(), status } };
  // Bank accounts are also shown by the legacy dashboard: keep its columns in step for verified, newer balances.
  const legacy = ['savings', 'current'].includes(a.subtype_code) && status === 'verified';
  const stmts = [[`INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (account_id, as_of) DO NOTHING RETURNING as_of`, [a.id, asOf.toISOString(), balance, status, note]]];
  if (legacy) stmts.push([`UPDATE wealth_accounts SET current_balance=$3, balance_as_of=$4, balance_status='verified', updated_at=now()
    WHERE user_id=$1 AND id=$2 AND (balance_as_of IS NULL OR balance_as_of < $4) RETURNING id`, [uid, a.id, balance, asOf.toISOString()]]);
  const [ins, upd = []] = await withActor(db, actor, stmts);
  return { accountId: a.id, stored: ins.length > 0, result: ins.length ? 'stored' : 'already_stored', legacyUpdated: upd.length > 0 };
}

export async function updateHolding(uid, b, { db = sql, actor = 'owner', dryRun = false, now = Date.now() } = {}) {
  const a = await ownAccount(db, uid, b?.accountId);
  if (!isUuid(b?.instrumentId)) throw httpError(400, 'instrumentId must be a uuid');
  const [h] = await db.query(`SELECT quantity::float8 AS quantity, invested_value::float8 AS invested_value, legacy_position_id, status
    FROM wealth_holdings WHERE account_id=$1 AND instrument_id=$2`, [a.id, b.instrumentId]);
  if (!h) throw httpError(404, 'Holding not found');
  const quantity = num(b.quantity), invested = b.investedValue === undefined || b.investedValue === null ? null : num(b.investedValue);
  if (!(quantity > 0) || quantity > 1e12) throw httpError(400, 'quantity must be a positive number');
  if (invested !== null && !(invested >= 0)) throw httpError(400, 'investedValue must be zero or more');
  const evidence = String(b.evidence || '').trim().slice(0, 300);
  if (evidence.length < 3) throw httpError(400, 'evidence is required (where the quantity comes from)');
  const asOf = when(b.asOf || new Date(now).toISOString());
  if (!notFuture(asOf, now)) throw httpError(400, 'asOf must be a date-time, not in the future');
  const change = { previous: { quantity: h.quantity, investedValue: h.invested_value }, next: { quantity, investedValue: invested ?? h.invested_value } };
  if (dryRun) return { dryRun, ...change };
  const correction = JSON.stringify({ previous_quantity: h.quantity, new_quantity: quantity, evidence, at: new Date(now).toISOString(), by: actor });
  const stmts = h.legacy_position_id
    // Update the legacy position; the Phase B trigger copies it into the holding (so a later legacy write agrees).
    ? [[`UPDATE wealth_positions SET quantity=$3, invested_value=coalesce($4, invested_value),
          current_value = CASE WHEN quantity > 0 AND current_value IS NOT NULL THEN round(current_value * $3 / quantity, 2) ELSE current_value END,
          balance_as_of=$5, updated_at=now(),
          metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('quantity_corrections', coalesce(metadata->'quantity_corrections','[]'::jsonb) || $6::jsonb)
        WHERE user_id=$1 AND id=$2 RETURNING id`, [uid, h.legacy_position_id, quantity, invested, asOf.toISOString(), correction]]]
    : [[`UPDATE wealth_holdings SET quantity=$3, invested_value=coalesce($4, invested_value), as_of=$5, status='active', closed_at=NULL
        WHERE account_id=$1 AND instrument_id=$2 RETURNING account_id`, [a.id, b.instrumentId, quantity, invested, asOf.toISOString()]]];
  if (b.releasePriceHold === true) stmts.push([`UPDATE wealth_instruments SET price_hold_reason=NULL WHERE id=$1 RETURNING id`, [b.instrumentId]]);
  await withActor(db, actor, stmts);
  const [after] = await db.query(`SELECT quantity::float8 AS quantity, invested_value::float8 AS invested_value, as_of FROM wealth_holdings WHERE account_id=$1 AND instrument_id=$2`, [a.id, b.instrumentId]);
  return { ...change, holding: after, priceHoldReleased: b.releasePriceHold === true };
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const PAYOUTS = ['cumulative', 'monthly', 'quarterly', 'yearly'], COMPOUNDING = ['simple', 'monthly', 'quarterly', 'half_yearly', 'yearly'];

export function checkFdTerms(t) {
  if (!t || typeof t !== 'object') return 'fdTerms must be an object';
  if (t.principal !== undefined && !(num(t.principal) > 0)) return 'principal must be positive';
  if (t.bookedOn !== undefined && !isDay(t.bookedOn)) return 'bookedOn must be YYYY-MM-DD';
  if (t.maturityOn !== undefined && !isDay(t.maturityOn)) return 'maturityOn must be YYYY-MM-DD';
  if (t.bookedOn && t.maturityOn && t.maturityOn <= t.bookedOn) return 'maturityOn must be after bookedOn';
  if (t.payout !== undefined && !PAYOUTS.includes(t.payout)) return 'payout must be one of ' + PAYOUTS.join(', ');
  if (t.compounding !== undefined && !COMPOUNDING.includes(t.compounding)) return 'compounding must be one of ' + COMPOUNDING.join(', ');
  return null;
}

export async function createAccount(uid, b, { db = sql, actor = 'owner' } = {}) {
  const [st] = await db.query(`SELECT code, category FROM wealth_account_subtypes WHERE code=$1`, [String(b?.subtype || '')]);
  if (!st) throw httpError(400, 'subtype must be one of the account subtypes');
  const institution = String(b.institution || '').trim().slice(0, 80), name = String(b.name || '').trim().slice(0, 80);
  if (!institution || !name) throw httpError(400, 'institution and name are required');
  const masked = b.maskedIdentifier ? String(b.maskedIdentifier).trim().slice(0, 20) : null;
  const currency = String(b.currency || (st.code === 'us_brokerage' ? 'USD' : 'INR'));
  if (!['INR', 'USD'].includes(currency)) throw httpError(400, 'currency must be INR or USD');
  const t = b.fdTerms || null;
  if (t && st.code !== 'fixed_deposit') throw httpError(400, 'fdTerms apply only to fixed deposits');
  if (t) { const p = checkFdTerms(t); if (p) throw httpError(400, p); }
  const key = [slug(institution), st.code, slug(name), masked ? slug(masked) : ''].filter(Boolean).join('-');
  const [rows] = await withActor(db, actor, [[`INSERT INTO wealth_accounts (user_id, account_key, bank_name, account_name, account_type, subtype_code,
      masked_identifier, currency, balance_status, fd_principal, fd_booked_on, fd_maturity_on, fd_payout, fd_compounding)
    VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'unknown',$8,$9,$10,$11,$12) ON CONFLICT (user_id, account_key) DO NOTHING RETURNING id, account_key`,
    [uid, key, institution, name, st.code, masked, currency, t?.principal ?? null, t?.bookedOn ?? null, t?.maturityOn ?? null, t?.payout ?? null, t?.compounding ?? null]]]);
  if (!rows.length) throw httpError(409, 'An account with this institution, type and name already exists');
  return { account: rows[0] };
}

export async function setFdTerms(uid, b, { db = sql, actor = 'owner' } = {}) {
  const a = await ownAccount(db, uid, b?.accountId);
  if (a.subtype_code !== 'fixed_deposit') throw httpError(400, 'FD terms apply only to fixed-deposit accounts');
  const p = checkFdTerms(b.fdTerms); if (p) throw httpError(400, p);
  const t = b.fdTerms;
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_accounts SET fd_principal=coalesce($3, fd_principal), fd_booked_on=coalesce($4::date, fd_booked_on),
      fd_maturity_on=coalesce($5::date, fd_maturity_on), fd_payout=coalesce($6, fd_payout), fd_compounding=coalesce($7, fd_compounding), updated_at=now()
    WHERE user_id=$1 AND id=$2
    RETURNING id, fd_principal::float8 AS principal, fd_booked_on::text AS booked_on, fd_maturity_on::text AS maturity_on, fd_payout AS payout, fd_compounding AS compounding`,
    [uid, a.id, t.principal ?? null, t.bookedOn ?? null, t.maturityOn ?? null, t.payout ?? null, t.compounding ?? null]]]);
  return { account: rows[0] };
}

// ── TR3-1.3 duplicates and TR3-1.8 unassigned transactions ───────────────────────────────────────────────────
export async function markDuplicate(uid, b, { db = sql, actor = 'owner' } = {}) {
  if (!isUuid(b?.transactionId)) throw httpError(400, 'transactionId must be a uuid');
  const keep = b.duplicateOf === null ? null : b.duplicateOf;
  if (keep !== null && !isUuid(keep)) throw httpError(400, 'duplicateOf must be a uuid, or null to unmark');
  const ids = keep ? [b.transactionId, keep] : [b.transactionId];
  const rows = await db.query(`SELECT id, kind, amount::text AS amount, duplicate_of FROM wealth_transactions WHERE user_id=$1 AND id = ANY($2::uuid[])`, [uid, ids]);
  const tx = rows.find(r => r.id === b.transactionId), kept = keep && rows.find(r => r.id === keep);
  if (!tx || (keep && !kept)) throw httpError(404, 'Transaction not found');
  if (keep) {
    if (keep === tx.id) throw httpError(400, 'A transaction cannot duplicate itself');
    if (kept.duplicate_of) throw httpError(409, 'The kept transaction is itself marked as a duplicate');
    if (kept.kind !== tx.kind || Number(kept.amount) !== Number(tx.amount)) throw httpError(400, 'Only a transaction with the same kind and amount can be a duplicate');
  }
  await withActor(db, actor, [[`UPDATE wealth_transactions SET duplicate_of=$3, duplicate_marked_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END
    WHERE user_id=$1 AND id=$2`, [uid, tx.id, keep]]]);
  return { transactionId: tx.id, duplicateOf: keep };
}

const words = d => String(d || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^\d+$/.test(w)).slice(0, 2).join(' ');   // merchant = leading words

// Suggest an account for each unassigned transaction from earlier assigned ones with the same leading words.
export async function suggestAccounts(uid, { db = sql } = {}) {
  const [open, history, accounts] = await Promise.all([
    db.query(`SELECT id, kind, description, amount::float8 AS amount, occurred_on::text AS occurred_on FROM wealth_transactions
      WHERE user_id=$1 AND account_id IS NULL ORDER BY occurred_on DESC LIMIT 500`, [uid]),
    db.query(`SELECT description, account_id FROM wealth_transactions WHERE user_id=$1 AND account_id IS NOT NULL`, [uid]),
    db.query(`SELECT id, bank_name, account_name, masked_identifier FROM wealth_accounts WHERE user_id=$1 AND status='active'`, [uid]),
  ]);
  const votes = new Map();
  for (const h of history) {
    const k = words(h.description); if (!k) continue;
    const m = votes.get(k) || new Map(); m.set(h.account_id, (m.get(h.account_id) || 0) + 1); votes.set(k, m);
  }
  const name = new Map(accounts.map(a => [a.id, `${a.bank_name} · ${a.account_name}${a.masked_identifier ? ' ' + a.masked_identifier : ''}`]));
  const suggestions = [];
  for (const t of open) {
    const m = votes.get(words(t.description)); if (!m) continue;
    const ranked = [...m.entries()].sort((x, y) => y[1] - x[1]);
    const [accountId, n] = ranked[0], total = ranked.reduce((s, [, c]) => s + c, 0);
    if (!name.has(accountId)) continue;
    suggestions.push({ transactionId: t.id, description: t.description, amount: t.amount, occurredOn: t.occurred_on, accountId, account: name.get(accountId),
      basis: `${n} of ${total} earlier "${words(t.description)}" transactions`, confidence: n / total });
  }
  return { unassigned: open.length, suggestions };
}

export async function assignAccounts(uid, assignments, { db = sql, actor = 'owner' } = {}) {
  if (!Array.isArray(assignments) || !assignments.length || assignments.length > 200) throw httpError(400, 'assignments: 1–200 {transactionId, accountId}');
  for (const x of assignments) if (!isUuid(x?.transactionId) || !isUuid(x?.accountId)) throw httpError(400, 'each assignment needs transactionId and accountId');
  const accountIds = [...new Set(assignments.map(x => x.accountId))];
  const ok = await db.query(`SELECT id FROM wealth_accounts WHERE user_id=$1 AND id = ANY($2::uuid[])`, [uid, accountIds]);
  if (ok.length !== accountIds.length) throw httpError(400, 'Unknown account');
  const [rows] = await withActor(db, actor, [[`UPDATE wealth_transactions t SET account_id = x.account_id
    FROM jsonb_to_recordset($2::jsonb) AS x(transaction_id uuid, account_id uuid)
    WHERE t.user_id=$1 AND t.id = x.transaction_id AND t.account_id IS NULL RETURNING t.id`,
    [uid, JSON.stringify(assignments.map(x => ({ transaction_id: x.transactionId, account_id: x.accountId })))]]]);
  return { assigned: rows.length, skipped: assignments.length - rows.length };
}
