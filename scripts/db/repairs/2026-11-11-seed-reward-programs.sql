-- 2026-11-11 · Plan 4 Part A (owner: "a"): seed reward programs and their first balances from saved screenshots.
-- Evidence (Tools → Records): "Paytm gold, silver and reward coin clarification" (9 Nov), "Paytm balance and spending
-- screenshots" (8 Nov), the 7 Nov ledger file, "Slice, Atom balances … Monies rewards" (9 Nov), "Credit card and Roarbank
-- screenshots" (8 Nov). Cash rewards (Spark, card cashback) are NOT copied: the programs sum the existing income
-- transactions through cash_match. Additive and idempotent: re-running adds nothing. Needs migration 0014.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);

WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
acc AS (SELECT a.id, a.bank_name, a.masked_identifier, a.account_type FROM wealth_accounts a JOIN o ON o.id = a.user_id),
p (program_key, provider, name, unit, account, inr_per_unit, rate_source, rate_as_of, min_redeem, redeem_note, cash_match) AS (VALUES
  ('paytm-gold-coins', 'Paytm', 'Paytm Gold Coins', 'Gold Coins', NULL, 0.01, 'Paytm screen 9 Nov 2026: 436 Gold Coins = ₹4.36 of real gold', '2026-11-09'::date, 500,
   'Payment rewards; convert to real gold at 500 coins. Kept apart from the 2 g Paytm Gold holding.', NULL),
  ('slice-monies', 'Slice', 'Slice Monies', 'Monies', NULL, 0.01, 'Slice remaining-monies screen 9 Nov 2026: 1,42,378 Monies shown as ₹1,423.78', '2026-11-09'::date, NULL,
   'Reward rate 1%; locked rate 2% unlocks at 5,00,000 Monies. Another screen showed ₹0 cash — confirm which value is withdrawable.', NULL),
  ('slice-spark', 'Slice', 'Slice Spark cashback', '₹ cashback', NULL, NULL, NULL, NULL, NULL,
   'Paid as money ("Spark cashback" income); totals come from transactions.', 'spark'),
  ('slice-card-cashback', 'Slice', 'Slice credit card cashback', '₹ cashback', 'slice-cc', NULL, NULL, NULL, NULL,
   'Merchant cashback credited to the Slice card ••6136; totals come from transactions.', 'credit card cashback|cashback'),
  ('hdfc-swiggy-orange', 'HDFC Bank', 'HDFC Swiggy Orange rewards', 'Reward points', 'hdfc-cc', NULL, NULL, NULL, NULL,
   'Card shows reward points (0 on 8 Nov); the 5% Swiggy cashback is credited to the card and summed from transactions.', 'cashback'),
  ('roarbank-rewards', 'Roarbank', 'Roarbank rewards', 'points', NULL, NULL, NULL, NULL, NULL,
   'No reward balance recorded yet — add one from a Roarbank screenshot.', NULL))
INSERT INTO wealth_reward_programs (user_id, program_key, provider, name, unit, account_id, inr_per_unit, rate_source, rate_as_of, min_redeem, redeem_note, cash_match)
SELECT o.id, p.program_key, p.provider, p.name, p.unit,
  CASE p.account WHEN 'slice-cc' THEN (SELECT id FROM acc WHERE bank_name = 'Slice' AND account_type = 'credit_card' AND masked_identifier = '••6136')
                 WHEN 'hdfc-cc' THEN (SELECT id FROM acc WHERE bank_name = 'HDFC Bank' AND account_type = 'credit_card' AND masked_identifier = '••9229') END,
  p.inr_per_unit, p.rate_source, p.rate_as_of, p.min_redeem, p.redeem_note, p.cash_match
FROM p CROSS JOIN o
ON CONFLICT (user_id, program_key) DO NOTHING;

WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
b (program_key, as_of, units, note) AS (VALUES
  ('paytm-gold-coins', '2026-11-07T12:00:00+05:30'::timestamptz, 430, 'Paytm screenshot (7 Nov ledger file)'),
  ('paytm-gold-coins', '2026-11-08T12:00:00+05:30'::timestamptz, 431, 'Paytm screenshot 8 Nov'),
  ('paytm-gold-coins', '2026-11-09T12:00:00+05:30'::timestamptz, 436, 'Paytm screenshot 9 Nov: 436 coins = ₹4.36 gold'),
  ('slice-monies',     '2026-11-07T12:00:00+05:30'::timestamptz, 130954, 'Slice screenshot (7 Nov ledger file)'),
  ('slice-monies',     '2026-11-09T12:00:00+05:30'::timestamptz, 142378, 'Slice Monies screen 9 Nov'),
  ('hdfc-swiggy-orange','2026-11-08T12:00:00+05:30'::timestamptz, 0, 'HDFC card screenshot 8 Nov: reward points 0'))
INSERT INTO wealth_reward_balances (program_id, as_of, units, status, note)
SELECT p.id, b.as_of, b.units, 'verified', b.note
FROM b JOIN wealth_reward_programs p ON p.program_key = b.program_key JOIN o ON o.id = p.user_id
ON CONFLICT (program_id, as_of) DO NOTHING;

COMMIT;
