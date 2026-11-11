-- 2026-11-11 · owner approval ("paytm summary approved"): keep the Paytm UPI statement 11 Nov 2023 – 10 Nov 2024
-- (151 pages, 963 payments) as ONE reference record in wealth_snapshots (Tools → Other records).
-- The payments are NOT added to wealth_transactions: the whole period is before the ledger starts (21 May 2026) and the
-- file holds only UPI payments, so whole months would look complete when they are not.
-- No name, phone number or email is stored. Additive and idempotent: re-running changes nothing.
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);

INSERT INTO wealth_snapshots (user_id, source_key, source_name, snapshot_date, payload)
SELECT o.id, 'paytm-upi-statement-2023-11-11..2024-11-10', 'Paytm UPI statement', '2024-11-10',
  jsonb_build_object(
    'kind', 'upi_statement_summary',
    'period', jsonb_build_object('from', '2023-11-11', 'to', '2024-11-10'),
    'totals', jsonb_build_object('paid', 1070611.47, 'paid_count', 846, 'received', 673561.70, 'received_count', 117,
                                 'note', 'Self-transfers are excluded by Paytm'),
    'sections', jsonb_build_array(
      jsonb_build_object(
        'heading', 'Paytm UPI statement — 11 Nov 2023 to 10 Nov 2024 (totals as printed)',
        'tables', jsonb_build_array(jsonb_build_array(
          jsonb_build_array('Account', 'Paid', 'Received'),
          jsonb_build_array('Bank of India ••56', '₹8,22,926.03 (578)', '₹5,33,053.70 (78)'),
          jsonb_build_array('Paytm Payments Bank ••31', '₹1,33,526.86 (151)', '₹28,427.00 (14)'),
          jsonb_build_array('HDFC Bank ••98', '₹1,07,600.45 (71)', '₹1,11,131.00 (24)'),
          jsonb_build_array('Other non-UPI accounts', '₹2,601.03 (4)', '₹950.00 (1)'),
          jsonb_build_array('Paytm Payments Bank net banking', '₹3,957.10 (42)', '₹0.00 (0)'),
          jsonb_build_array('Total', '₹10,70,611.47 (846)', '₹6,73,561.70 (117)'))),
        'notes', jsonb_build_array(
          'Reference only: the payments are not in Activity (the period is before 21 May 2026, and only UPI payments are in the file).',
          'Many payments to "Neblio Technologies" (notes "DCX" = CoinDCX) and to "Bitcipherlabsllp" (likely CoinSwitch): crypto purchases. Crypto holdings are not recorded in the app; owner to confirm.',
          '₹15,000 to "NDX P2P Pvt Ltd" on 20 Nov 2023 (likely LiquiLoans P2P lending); owner to confirm whether still invested.',
          'Monthly ₹21,600 to "HDFC A/c ••7649" around the 15th, usually right after ₹21,600 from Subramanian P (looks like a loan EMI paid on behalf).',
          'Loan / BNPL repayments in the period: EarlySalary (₹4,241 monthly), IDFC First loan, LazyPay, Paytm Postpaid.',
          '"Angel Ltd NSE" payments match Funds Added entries in the Angel One ledger (wealth_broker_ledger).')))
  )
FROM (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1) o
ON CONFLICT (user_id, source_key) DO NOTHING;

COMMIT;
