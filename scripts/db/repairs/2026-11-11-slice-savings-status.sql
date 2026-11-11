-- 2026-11-11 · owner: "now fix it". An external writer (ChatGPT, actor 'external') added "UPI transfer to Arun S" ₹5,000 at
-- 13:40 IST and set Slice Savings ••3731 to ₹42,889.22 with balance_status 'pending_reconciliation'. Totals count only
-- 'verified' and 'stale' (estimated) balances, so the account dropped out of the bank total and net worth.
-- The amount is right (estimate ₹47,889.22 − ₹5,000), so the status becomes 'stale' / 'estimated'. Amounts unchanged;
-- nothing deleted; idempotent (only rows still pending_reconciliation are changed).
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_accounts SET balance_status = 'stale', updated_at = now()
WHERE account_key = 'slice-savings-3731' AND balance_status = 'pending_reconciliation';
UPDATE wealth_account_balances b SET status = 'estimated',
  note = 'estimated: ₹47,889.22 estimate − ₹5,000 UPI transfer to Arun S (added by external writer 11 Nov 13:40 IST)'
FROM wealth_accounts a
WHERE a.id = b.account_id AND a.account_key = 'slice-savings-3731' AND b.status = 'pending_reconciliation';
COMMIT;
