-- 2026-11-11 · owner: "this is splits" (Atom screen, 11 Nov 5:21 PM IST): Atom Savings ("Slice Atom") = ₹63,448.36 in
--   Invest later ₹30,036 · Rent ₹8,209 · Emergency fund ₹25,030 · Round ups ₹172 (2x spare change)  — sum ₹63,447 (rounded).
-- Creates the four splits with verified balances at 5:21 PM, and records the November round-ups (₹141 on 7 Nov, ₹18 on
-- 11 Nov) as + movements into Round ups linked to their transactions (history only: they are before the verified balance,
-- so they do not change it). Additive and idempotent. Needs migration 0019.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
WITH o AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
atom AS (SELECT a.id FROM wealth_accounts a JOIN o ON o.id = a.user_id WHERE a.bank_name = 'Atom' AND a.account_name = 'Atom Savings'),
v (split_key, name, kind, sort_order, purpose) AS (VALUES
  ('invest-later',   'Invest later',   'goal',     1, 'Money set aside to invest later'),
  ('rent',           'Rent',           'goal',     2, 'Rent is paid from here'),
  ('emergency-fund', 'Emergency fund', 'goal',     3, 'Emergency savings'),
  ('round-ups',      'Round ups',      'roundups', 4, '2x spare change from card and UPI payments'))
INSERT INTO wealth_account_splits (user_id, account_id, split_key, name, kind, sort_order, purpose)
SELECT o.id, atom.id, v.split_key, v.name, v.kind, v.sort_order, v.purpose FROM v, o, atom
ON CONFLICT (account_id, split_key) DO NOTHING;

WITH b (split_key, balance) AS (VALUES ('invest-later', 30036), ('rent', 8209), ('emergency-fund', 25030), ('round-ups', 172))
INSERT INTO wealth_account_split_balances (split_id, as_of, balance, status, note)
SELECT s.id, '2026-11-11T17:21:00+05:30'::timestamptz, b.balance, 'verified', 'Atom screen 11 Nov 5:21 PM (whole rupees; Atom total ₹63,448.36)'
FROM b JOIN wealth_account_splits s ON s.split_key = b.split_key
JOIN wealth_accounts a ON a.id = s.account_id AND a.bank_name = 'Atom' AND a.account_name = 'Atom Savings'
ON CONFLICT (split_id, as_of) DO NOTHING;

INSERT INTO wealth_account_split_moves (split_id, occurred_at, amount, transaction_id, note)
SELECT s.id, (t.occurred_on::text || 'T12:00:00+05:30')::timestamptz, t.amount, t.id, 'November round-ups (history; included in the 11 Nov balance)'
FROM wealth_transactions t
JOIN wealth_accounts a ON a.id = t.account_id AND a.bank_name = 'Atom' AND a.account_name = 'Atom Savings'
JOIN wealth_account_splits s ON s.account_id = a.id AND s.split_key = 'round-ups'
WHERE t.kind = 'transfer' AND t.description = 'November round-ups' AND t.duplicate_of IS NULL
ON CONFLICT (split_id, transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING;
COMMIT;
