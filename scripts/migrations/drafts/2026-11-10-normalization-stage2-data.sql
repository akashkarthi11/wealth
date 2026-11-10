-- Normalization stage 2: remove duplicated data. Changes rows — needs explicit approval per environment.
-- DRAFT — not run by scripts/migrate-db.mjs. Run scripts/db/audit-duplicates.sql before and after.
-- Sections marked "DECISION NEEDED" are commented out until the owner confirms the specific rows.

BEGIN;

-- A. Active mandates linked to obligations that were cancelled as "duplicate bills".
--    The commitment itself is still live (the mandate is active), so the obligation must stay active
--    and point at the mandate. Its planned payment occurrences then become valid again.
--    Affects today: LIC policy premium (14 Nov) and Slice auto-deposit (4 Dec).
UPDATE wealth_recurring_obligations r
SET status = 'active',
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

-- B. One open-ended rate per product: close the older row when a newer open-ended row exists.
UPDATE wealth_interest_rates old
SET effective_to = newer.effective_from - 1
FROM wealth_interest_rates newer
WHERE old.provider = newer.provider
  AND old.product_key = newer.product_key
  AND old.effective_to IS NULL AND newer.effective_to IS NULL
  AND newer.effective_from > old.effective_from;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_interest_rates_one_open_uq
  ON wealth_interest_rates (provider, product_key) WHERE effective_to IS NULL;

-- C. Position metadata must not repeat values held in columns, price history or the source snapshot.
--    name/ticker/quantity/current_value -> columns; average_price = invested_value / quantity;
--    last_traded_price -> wealth_price_history; original_holding -> wealth_snapshots via source_snapshot_id.
--    No dashboard code reads these keys. Side effect: the deploy-time Angel One price seed
--    (reads metadata->>'last_traded_price') stops overwriting live prices.
UPDATE wealth_positions
SET metadata = metadata - ARRAY['name','ticker','quantity','current_value','average_price','last_traded_price','original_holding'],
    updated_at = now()
WHERE metadata ?| ARRAY['name','ticker','quantity','current_value','average_price','last_traded_price','original_holding'];

-- D. Stock Advisor report stored a second time as a snapshot (the API only falls back to snapshots
--    when the report table is empty). Delete only if the report table holds a report within an hour.
DELETE FROM wealth_snapshots s
WHERE s.source_key ILIKE 'stock-advisor%'
  AND EXISTS (SELECT 1 FROM wealth_stock_advisor_reports r
              WHERE r.user_id = s.user_id AND abs(extract(epoch FROM r.run_at - s.created_at)) <= 3600);

-- E. DECISION NEEDED — fixed deposits stored as a bank account AND as FD positions.
--    The 'fixed-deposits' account (₹3,004.00) is a stale copy of the Slice FD position (₹3,004.41).
--    It is excluded from CASA, but it is a second copy of the same money. Remove it only if no
--    transaction, bill or mandate references it (the composite FKs will refuse otherwise).
-- DELETE FROM wealth_accounts WHERE account_key = 'fixed-deposits' AND account_type = 'fixed_deposit';

-- F. DECISION NEEDED — five pairs of identical transactions. Some may be genuine (two ₹100 Awfis
--    charges on one day). Run audit query 1, confirm each pair, then delete the extra id only.
-- DELETE FROM wealth_transactions WHERE id IN (/* confirmed duplicate ids */);

COMMIT;
