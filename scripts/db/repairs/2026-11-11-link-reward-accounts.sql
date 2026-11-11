-- 2026-11-11 · owner: "every thing link to account". Link each reward program that has no account yet:
--   Paytm Gold Coins → Paytm Gold (digital gold; the coins convert to gold)   Slice Monies → Slice Savings ••3731
--   Slice Spark cashback → Slice Savings ••3731 (its credits were imported without an account → count them from any account)
--   Roarbank rewards → Roarbank Credit Card
-- Card cashback programs were already linked (Slice ••6136, HDFC ••9229). Only empty links are filled; idempotent. Needs 0017.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
l (program_key, bank_name, account_type, masked, any_account) AS (VALUES
  ('paytm-gold-coins', 'Paytm Gold', 'digital_gold', NULL, false),
  ('slice-monies',     'Slice',      'savings',      '••3731', false),
  ('slice-spark',      'Slice',      'savings',      '••3731', true),
  ('roarbank-rewards', 'Roarbank',   'credit_card',  NULL, false))
UPDATE wealth_reward_programs p
SET account_id = a.id, cash_any_account = p.cash_any_account OR l.any_account, updated_at = now()
FROM l, o, wealth_accounts a
WHERE p.user_id = o.id AND p.program_key = l.program_key AND p.account_id IS NULL
  AND a.user_id = o.id AND a.bank_name = l.bank_name AND a.account_type = l.account_type AND a.status = 'active'
  AND (l.masked IS NULL OR a.masked_identifier = l.masked);
COMMIT;
