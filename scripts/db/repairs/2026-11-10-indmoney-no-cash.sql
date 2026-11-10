-- Owner (2026-11-10): there is no cash in the INDmoney account.
-- Records a new $0 balance as of now; the earlier $10.02 buying-power row stays in the history.
-- Insert only. Safe to re-run: skips if the latest balance is already 0.
-- Run: node scripts/db/run-sql.mjs <env-file> scripts/db/repairs/2026-11-10-indmoney-no-cash.sql --apply --yes
BEGIN;

INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note)
SELECT a.id, now(), 0, 'reported', 'Owner 2026-11-10: no cash in INDmoney (previous buying power kept in history)'
FROM wealth_accounts a
WHERE a.subtype_code = 'us_brokerage' AND a.status = 'active' AND a.bank_name = 'INDmoney'
  AND coalesce((SELECT b.balance FROM wealth_v_latest_balances b WHERE b.account_id = a.id), -1) <> 0;

COMMIT;
