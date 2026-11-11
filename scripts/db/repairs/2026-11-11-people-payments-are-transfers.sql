-- 2026-11-11 · owner: "Activity fixes - all are transfer". Payments to / from people are transfers, not spending or income,
-- so they no longer count in money in / out. Only kind + category change; amounts, dates, accounts untouched. Idempotent.
--   Arun S ₹5,000 (11 Nov, Slice Savings)        expense 'Money Transfer' → transfer 'Transfer sent'
--   M Saravanan ₹100 (8 Nov, Slice Savings)       expense 'Money Transfer' → transfer 'Transfer sent'
--   Gullak Technologies ₹1 (11 Nov, Slice Savings) expense 'Shopping'     → transfer 'Transfer sent'
--   Lavanya ₹500 (8 Nov, no account)              income 'Transfer received' → transfer 'Transfer received'
BEGIN;
SELECT set_config('wealth.actor', 'owner', true);
UPDATE wealth_transactions t SET kind = 'transfer', category = v.category
FROM (VALUES
  ('0088c747-72e7-43ad-a184-1377887e2feb'::uuid, 'Transfer sent'),
  ('0d462377-5bc5-4a0b-a50d-a8777ad7a846'::uuid, 'Transfer sent'),
  ('49d9b6af-1daf-471b-95a2-b1e5874343ce'::uuid, 'Transfer sent'),
  ('9979eae6-3dd7-42c9-a239-b306f96e9233'::uuid, 'Transfer received')
) v(id, category)
WHERE t.id = v.id AND (t.kind <> 'transfer' OR t.category <> v.category);
COMMIT;
