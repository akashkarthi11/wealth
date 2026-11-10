-- Read-only duplicate and key-integrity audit. Every statement is a SELECT.
-- Run before and after each normalization stage; every query should return 0 rows when clean.

-- 1. Transactions that look identical (same user, kind, amount, date, account, description).
--    Not all are errors (two identical purchases on one day are possible): review, never auto-delete.
SELECT user_id, kind, amount, occurred_on, account_id, description, count(*) AS copies, array_agg(id) AS ids
FROM wealth_transactions
GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1;

-- 2. More than one active position for the same holding.
SELECT user_id, category, record_type, platform_name, lower(coalesce(ticker, name)) AS holding, count(*)
FROM wealth_positions WHERE record_type NOT LIKE '%\_ARCHIVED'
GROUP BY 1,2,3,4,5 HAVING count(*) > 1;

-- 3. Child rows whose user_id disagrees with their parent's user_id.
SELECT 'investment_assets' AS child, a.id FROM wealth_investment_assets a JOIN wealth_positions p ON p.id = a.position_id WHERE p.user_id <> a.user_id
UNION ALL SELECT 'market_prices', m.id FROM wealth_market_prices m JOIN wealth_investment_assets a ON a.id = m.asset_id WHERE a.user_id <> m.user_id
UNION ALL SELECT 'payment_occurrences', o.id FROM wealth_payment_occurrences o JOIN wealth_recurring_obligations r ON r.id = o.obligation_id WHERE r.user_id <> o.user_id
UNION ALL SELECT 'subscriptions.obligation', s.id FROM wealth_subscriptions s JOIN wealth_recurring_obligations r ON r.id = s.obligation_id WHERE r.user_id <> s.user_id
UNION ALL SELECT 'planned_bills.account', b.id FROM wealth_planned_bills b JOIN wealth_accounts a ON a.id = b.account_id WHERE a.user_id <> b.user_id
UNION ALL SELECT 'positions.snapshot', p.id FROM wealth_positions p JOIN wealth_snapshots s ON s.id = p.source_snapshot_id WHERE s.user_id <> p.user_id;

-- 4. Price history rows whose user_id disagrees with the asset (bigint ids, kept separate).
SELECT h.id FROM wealth_price_history h JOIN wealth_investment_assets a ON a.id = h.asset_id WHERE a.user_id <> h.user_id;

-- 5. Active mandates linked to a cancelled/completed obligation.
SELECT s.id, s.provider_key, r.obligation_key, r.status
FROM wealth_subscriptions s JOIN wealth_recurring_obligations r ON r.id = s.obligation_id
WHERE s.status = 'active' AND r.status IN ('cancelled', 'completed');

-- 6. Planned payment occurrences under a cancelled/completed obligation.
SELECT o.id, r.obligation_key, o.due_date, o.status
FROM wealth_payment_occurrences o JOIN wealth_recurring_obligations r ON r.id = o.obligation_id
WHERE o.status = 'planned' AND r.status IN ('cancelled', 'completed');

-- 7. More than one open-ended interest rate per product.
SELECT provider, product_key, count(*) FROM wealth_interest_rates
WHERE effective_to IS NULL GROUP BY 1,2 HAVING count(*) > 1;

-- 8. Fixed-deposit balances stored as a bank account as well as FD positions.
SELECT a.id, a.account_key, a.current_balance FROM wealth_accounts a
WHERE a.account_type = 'fixed_deposit'
  AND EXISTS (SELECT 1 FROM wealth_positions p WHERE p.user_id = a.user_id AND p.record_type = 'FIXED_DEPOSIT');

-- 9. Position metadata repeating values that already have a column or live in the source snapshot.
SELECT id, name, array(SELECT k FROM jsonb_object_keys(metadata) k
  WHERE k IN ('name','ticker','quantity','current_value','average_price','last_traded_price','original_holding')) AS duplicated_keys
FROM wealth_positions
WHERE metadata ?| array['name','ticker','quantity','current_value','average_price','last_traded_price','original_holding'];

-- 10. Investment assets repeating the position's name/currency.
SELECT a.id, a.display_name, a.price_currency FROM wealth_investment_assets a JOIN wealth_positions p ON p.id = a.position_id
WHERE a.display_name = p.name AND a.price_currency = p.currency;

-- 11. Stock Advisor reports with the same run time, or also stored as snapshots.
SELECT user_id, run_at, count(*) FROM wealth_stock_advisor_reports GROUP BY 1,2 HAVING count(*) > 1;
SELECT id, source_key FROM wealth_snapshots WHERE source_key ILIKE 'stock-advisor%';

-- 12. Indexes that duplicate another index on the same table and columns (sort direction ignored:
--     a btree scans both ways). The unique/constraint index is always the one kept.
SELECT a.indexrelid::regclass AS duplicate_index, b.indexrelid::regclass AS kept_index
FROM pg_index a JOIN pg_index b
  ON a.indrelid = b.indrelid AND a.indexrelid <> b.indexrelid
 AND a.indkey::text = b.indkey::text
 AND coalesce(a.indpred::text, '') = coalesce(b.indpred::text, '')
 AND coalesce(a.indexprs::text, '') = coalesce(b.indexprs::text, '')
 AND ((b.indisunique AND NOT a.indisunique)
      OR (a.indisunique = b.indisunique
          AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = a.indexrelid)
          AND (EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = b.indexrelid) OR a.indexrelid > b.indexrelid)))
JOIN pg_class c ON c.oid = a.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';
