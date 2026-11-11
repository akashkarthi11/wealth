-- 2026-11-11 · owner: "current slice cc -30557.95" and "yes" (older Arun S payments are transfers).
-- 1) Slice Credit Card owed ₹30,557.95 (= ₹30,536.95 + ₹21 MMTC PAMP on 11 Nov), as the owner reported from the Slice app.
--    Recorded the same way as the previous card figure: history row 'reported', dashboard columns kept in step so the
--    balance_mismatch check stays clear. Liabilities are stored as a positive outstanding amount.
-- 2) Three HDFC UPI payments to Arun S stored as spending → transfer 'Transfer sent' (kind + category only).
-- Nothing deleted; idempotent.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note)
VALUES ('6915ab8e-3a6b-4291-ab54-f97435d1bc54', '2026-11-11T18:10:00+05:30', 30557.95, 'reported',
        'Owner: Slice credit card outstanding ₹30,557.95 (shown as -₹30,557.95) after the ₹21 MMTC PAMP spend on 11 Nov')
ON CONFLICT (account_id, as_of) DO NOTHING;
UPDATE wealth_accounts SET current_balance = 30557.95, balance_as_of = '2026-11-11T18:10:00+05:30', balance_status = 'verified', updated_at = now()
WHERE id = '6915ab8e-3a6b-4291-ab54-f97435d1bc54' AND (balance_as_of IS NULL OR balance_as_of < '2026-11-11T18:10:00+05:30');
UPDATE wealth_transactions SET kind = 'transfer', category = 'Transfer sent'
WHERE id IN ('fe060984-116b-43a1-8d08-064fe1d407b2', '5df9c6cb-816f-4cb3-9ed1-6e00124e3e7a', 'ea80164d-819e-4009-8561-153e38a8482e')
  AND (kind <> 'transfer' OR category <> 'Transfer sent');
COMMIT;
