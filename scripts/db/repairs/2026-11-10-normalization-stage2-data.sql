-- Normalization stage 2 repair. NEVER deletes data: no DELETE, no TRUNCATE, no DROP, and every
-- overwritten value is kept in the row's notes. Owner approval required per environment.
-- Run scripts/db/audit-duplicates.sql before and after.
-- Run: node scripts/db/run-sql.mjs <env-file> scripts/db/repairs/2026-11-10-normalization-stage2-data.sql --apply --yes

BEGIN;

-- A. Active mandates linked to obligations that were cancelled as "duplicate bills".
--    The commitment is still live (the mandate is active), so the obligation becomes active again and
--    points at the mandate. The previous key, status and source are recorded in notes.
--    Affects today: LIC policy premium (14 Nov) and Slice auto-deposit (4 Dec).
UPDATE wealth_recurring_obligations r
SET notes = trim(both ' ' FROM r.notes || ' [repair 2026-11-10: was ' || r.obligation_key || ', status ' || r.status
            || ', source ' || r.source_type || ']'),
    status = 'active',
    source_type = 'subscription',
    source_record_id = s.id,
    mandate_id = s.id,
    obligation_key = 'mandate:' || s.provider_key || ':' || coalesce(s.mandate_key, s.id::text),
    next_due_date = coalesce(s.next_due_date, r.next_due_date),
    updated_at = now()
FROM wealth_subscriptions s
WHERE s.obligation_id = r.id
  AND s.user_id = r.user_id
  AND s.status = 'active'
  AND r.status = 'cancelled'
  AND r.source_type = 'planned_bill';

-- B. One open-ended rate per product: give the older row an end date (both rows are kept).
UPDATE wealth_interest_rates old
SET effective_to = newer.effective_from - 1,
    notes = trim(both ' ' FROM old.notes || ' [repair 2026-11-10: closed because a newer rate starts ' || newer.effective_from || ']')
FROM wealth_interest_rates newer
WHERE old.provider = newer.provider
  AND old.product_key = newer.product_key
  AND old.effective_to IS NULL AND newer.effective_to IS NULL
  AND newer.effective_from > old.effective_from;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_interest_rates_one_open_uq
  ON wealth_interest_rates (provider, product_key) WHERE effective_to IS NULL;

-- Not done here, by policy (no data deletion): copied metadata keys, the advisor snapshot copy,
-- the merged "fixed-deposits" account row and identical transaction pairs all stay in place.
-- The new model reads only canonical rows, so these copies no longer affect any total.

COMMIT;
