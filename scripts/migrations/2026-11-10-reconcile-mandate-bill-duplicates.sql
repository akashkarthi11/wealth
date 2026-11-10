-- Reconcile planned-bill rows that duplicate an active bank mandate.
-- Keep the mandate as the canonical authorisation and retain the bill row for audit history.
-- Match on user, provider key (exact or generated suffix), amount, linked account, and due date.
-- Safe to rerun: only currently planned duplicates are changed.
BEGIN;

UPDATE wealth_planned_bills b
SET status='cancelled',
    updated_at=now()
FROM wealth_subscriptions s
WHERE b.user_id=s.user_id
  AND s.status='active'
  AND b.status='planned'
  AND b.amount=s.amount
  AND b.account_id=s.source_account_id
  AND s.next_due_date IS NOT NULL
  AND b.due_date=s.next_due_date
  AND (
    b.bill_key=s.provider_key
    OR left(b.bill_key,length(s.provider_key)+1)=s.provider_key || '_'
  );

COMMIT;
