-- 2026-11-11 · owner report "fd intrest not calculated". Both FDs were linked and had rates but no terms, so accrual stopped
-- at "pending_terms". Terms set from evidence + owner answers (tenure "Don't know" → no maturity; payout "At maturity"):
--   Slice FD          ₹3,001 · 7.75% · booked 2026-11-05 (₹3,004.41 on 10 Nov ≈ 5 days of interest) · cumulative, quarterly
--   Angel One FD      ₹1,000 · 8%    · booked 2026-11-05 (₹1.09 interest on 10 Nov = 5 days at 8%; ₹1,000 to Unity SFB on 5 Nov)
-- The FD rate is fixed at booking, so each FD's rate period starts on its booking day (was 2026-11-10).
-- Only empty terms are filled; nothing deleted; idempotent.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_accounts SET fd_principal = v.principal, fd_booked_on = '2026-11-05', fd_payout = 'cumulative', fd_compounding = 'quarterly', updated_at = now()
FROM (VALUES ('slice-fixed_deposit-slice-fd', 3001.00), ('angel-one-fixed_deposit-angel-one-fd-aggregate-', 1000.00)) v(account_key, principal)
WHERE wealth_accounts.account_key = v.account_key AND wealth_accounts.subtype_code = 'fixed_deposit' AND wealth_accounts.fd_principal IS NULL;
UPDATE wealth_interest_rates r SET effective_from = '2026-11-05'
FROM wealth_interest_products p
WHERE p.id = r.product_id AND p.product_key IN ('slice-fd', 'angel-one-fd') AND r.effective_from = '2026-11-10'
  AND NOT EXISTS (SELECT 1 FROM wealth_interest_rates r2 WHERE r2.product_id = r.product_id AND r2.effective_from < '2026-11-10');
-- Owner, 2026-11-11: "current slice fd price 3005.04" (was ₹3,004.41 on 10 Nov; +₹0.63 = one day at 7.75% on ₹3,001).
UPDATE wealth_positions SET current_value = 3005.04, balance_as_of = '2026-11-11T12:00:00+05:30', updated_at = now(),
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('displayed_current_value_inr', 3005.04, 'value_source', 'owner, 2026-11-11')
WHERE record_type = 'FIXED_DEPOSIT' AND name = 'Slice FD' AND current_value IS DISTINCT FROM 3005.04
  AND (balance_as_of IS NULL OR balance_as_of < '2026-11-11T12:00:00+05:30');
-- Owner, 2026-11-11: "angleone -1001.30" (was ₹1,001.09 on 10 Nov; +₹0.21 = one day at 8% on ₹1,000).
UPDATE wealth_positions SET current_value = 1001.30, balance_as_of = '2026-11-11T12:00:00+05:30', updated_at = now(),
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('interest_earned_inr', 1.30, 'value_source', 'owner, 2026-11-11')
WHERE record_type = 'FIXED_DEPOSIT' AND name = 'Angel One FD (aggregate)' AND current_value IS DISTINCT FROM 1001.30
  AND (balance_as_of IS NULL OR balance_as_of < '2026-11-11T12:00:00+05:30');
COMMIT;
