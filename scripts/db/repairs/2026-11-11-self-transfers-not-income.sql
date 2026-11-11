-- 2026-11-11 · owner request ("find all self transfer dont count in in and out money"; approved "yes ok").
-- Money in / out counts only kind income and expense (+ investment, liability); kind transfer is shown apart.
-- Audit of every non-transfer row: two credits from the owner's own accounts were stored as income
-- ("Unconfirmed credit — verify", workbook import, 3 Nov 2026: ₹80,000 and ₹800). They become Self transfers.
-- Nothing deleted; idempotent (only rows still kind income are changed).
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_transactions t SET kind = 'transfer', category = 'Self transfer'
FROM (SELECT id FROM wealth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1) o
WHERE t.user_id = o.id AND t.kind = 'income' AND t.duplicate_of IS NULL AND t.occurred_on = '2026-11-03'
  AND t.category LIKE 'Unconfirmed credit%' AND t.description IN ('Karthikeyan Subramanian', 'Karthikeyan S')
  AND t.amount IN (80000.00, 800.00);
COMMIT;