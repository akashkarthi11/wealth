-- 2026-11-11 · owner request ("use it"): use the super.money UPI history (sm_receipt_1794380635759.pdf, 28 Aug 2024 – 29 Sep 2026).
-- (a) Add the 8 Slice Savings ••3731 payments that are missing from wealth_transactions (all inside the period the ledger
--     covers, from 21 May 2026). The Slice credit-card rows in the same file are already stored and are not touched.
-- (b) Keep the file as one reference record (wealth_snapshots → Tools → Other records). Older rows are NOT added to
--     transactions: the file has only super.money payments, so whole months would look complete when they are not.
-- Additive and idempotent: nothing is updated or deleted; re-running adds nothing.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);

WITH owner AS (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1),
acct AS (SELECT a.id, a.user_id, a.account_name || ' ' || coalesce(a.masked_identifier, '') AS label
         FROM wealth_accounts a JOIN owner o ON o.id = a.user_id
         WHERE a.bank_name = 'Slice' AND a.account_name = 'Slice Savings' AND a.masked_identifier = '••3731'),
rows (occurred_on, amount, merchant) AS (VALUES
  ('2026-06-03'::date,  65.00, 'WWW AWFIS COM'),
  ('2026-06-10'::date, 220.00, 'WWW AWFIS COM'),
  ('2026-06-12'::date, 140.00, 'WWW AWFIS COM'),
  ('2026-06-15'::date,  70.00, 'WWW AWFIS COM'),
  ('2026-06-16'::date,  75.00, 'WWW AWFIS COM'),
  ('2026-06-17'::date,  70.00, 'WWW AWFIS COM'),
  ('2026-06-24'::date, 145.00, 'WWW AWFIS COM'),
  ('2026-09-29'::date, 150.00, 'AWFIS'))
INSERT INTO wealth_transactions (user_id, kind, category, description, amount, account, account_id, occurred_on)
SELECT acct.user_id, 'expense', 'Awfis', 'Awfis · UPI · super.money (' || r.merchant || ')', r.amount, acct.label, acct.id, r.occurred_on
FROM rows r CROSS JOIN acct
WHERE NOT EXISTS (SELECT 1 FROM wealth_transactions t
                  WHERE t.user_id = acct.user_id AND t.account_id = acct.id AND t.occurred_on = r.occurred_on
                    AND t.amount = r.amount AND t.description LIKE 'Awfis · UPI · super.money%');

INSERT INTO wealth_snapshots (user_id, source_key, source_name, snapshot_date, payload)
SELECT o.id, 'supermoney-upi-history-2026-11-11', 'super.money UPI history', '2026-11-11',
  jsonb_build_object(
    'file', 'sm_receipt_1794380635759.pdf',
    'period', jsonb_build_object('from', '2024-08-28', 'to', '2026-09-29'),
    'sections', jsonb_build_array(jsonb_build_object(
      'heading', 'super.money UPI history — 28 Aug 2024 to 29 Sep 2026',
      'tables', jsonb_build_array(jsonb_build_array(
        jsonb_build_array('UPI source', 'Period in the file', 'Used'),
        jsonb_build_array('Slice Savings ••3731', 'Feb 2026 – Sep 2026', '8 payments from Jun–Sep 2026 added to transactions (₹935); earlier rows kept here only'),
        jsonb_build_array('Slice credit card ••36', 'Feb 2026 – Jul 2026', 'Rows from 21 May 2026 were already in transactions'),
        jsonb_build_array('Unity SFB credit card ••79', 'Feb 2026 – Apr 2026', 'Reference only'),
        jsonb_build_array('Bank of India ••4556', 'Aug 2024 – Feb 2026', 'Reference only'),
        jsonb_build_array('HDFC ••9498', 'Oct 2024 – Dec 2024', 'Reference only'))),
      'notes', jsonb_build_array(
        'Only payments made through the super.money app; not a full bank statement.',
        'Rows before 21 May 2026 are not added to transactions so monthly spending averages stay correct.',
        'Failed payments in the file are ignored. super.money credits are small cashback amounts.')))
  )
FROM (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1) o
ON CONFLICT (user_id, source_key) DO NOTHING;

COMMIT;
