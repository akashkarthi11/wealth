-- Read-only preview: how today's rows map into  user -> account (CASA / INVESTMENT / LIABILITY) -> subtype -> data.
-- Nothing is written. Used to validate the hierarchy model before any migration.
WITH subtype_map(record_type, subtype, category, valuation) AS (VALUES
  ('EQUITY','demat_equity','INVESTMENT','holdings'),
  ('MUTUAL_FUND','mutual_fund','INVESTMENT','holdings'),
  ('US_EQUITY','us_brokerage','INVESTMENT','holdings'),
  ('ETF','us_brokerage','INVESTMENT','holdings'),
  ('GOLD','digital_gold','INVESTMENT','holdings'),
  ('SILVER','digital_silver','INVESTMENT','holdings'),
  ('FIXED_DEPOSIT','fixed_deposit','INVESTMENT','balance'),
  ('EPF','provident_fund','INVESTMENT','balance'),
  ('CREDIT_CARD','credit_card','LIABILITY','balance')
), bank_accounts AS (
  SELECT a.user_id,
         CASE a.account_type WHEN 'credit_card' THEN 'LIABILITY' WHEN 'fixed_deposit' THEN 'INVESTMENT' ELSE 'CASA' END AS category,
         a.account_type AS subtype,
         a.bank_name || ' · ' || a.account_name || coalesce(' ' || a.masked_identifier, '') AS account,
         CASE WHEN a.account_type = 'fixed_deposit' THEN 'DUPLICATE of FD positions — not migrated'
              WHEN a.current_balance IS NULL THEN 'no balance yet'
              ELSE 'balance ' || a.current_balance || ' (' || a.balance_status || ')' END AS data,
         (SELECT count(*) FROM wealth_transactions t WHERE t.account_id = a.id) AS transactions
  FROM wealth_accounts a
), position_accounts AS (
  SELECT p.user_id, m.category, m.subtype,
         CASE WHEN m.subtype = 'credit_card' THEN 'Slice · Slice Credit Card ••' || (p.metadata->>'masked_card') || '  (merges into the bank-account row above)'
              WHEN m.valuation = 'balance' THEN coalesce(p.institution_name, p.platform_name) || ' · ' || p.name
              ELSE p.platform_name || ' · ' || initcap(replace(m.subtype, '_', ' ')) END AS account,
         CASE WHEN m.valuation = 'holdings'
              THEN count(*) || ' holding(s): ' || string_agg(coalesce(p.ticker, p.name), ', ' ORDER BY coalesce(p.ticker, p.name))
              ELSE 'balance ' || max(p.current_value) END AS data,
         0::bigint AS transactions
  FROM wealth_positions p JOIN subtype_map m ON m.record_type = p.record_type
  WHERE p.record_type NOT LIKE '%\_ARCHIVED'
  GROUP BY p.user_id, m.category, m.subtype, m.valuation,
           CASE WHEN m.valuation = 'balance' THEN p.id END,
           CASE WHEN m.subtype = 'credit_card' THEN 'Slice · Slice Credit Card ••' || (p.metadata->>'masked_card') || '  (merges into the bank-account row above)'
                WHEN m.valuation = 'balance' THEN coalesce(p.institution_name, p.platform_name) || ' · ' || p.name
                ELSE p.platform_name || ' · ' || initcap(replace(m.subtype, '_', ' ')) END
)
SELECT u.email AS "user", x.category AS "type", x.subtype, x.account, x.data, x.transactions
FROM (SELECT * FROM bank_accounts UNION ALL SELECT * FROM position_accounts) x
JOIN wealth_users u ON u.id = x.user_id
ORDER BY 1, array_position(ARRAY['CASA','INVESTMENT','LIABILITY'], x.category), 3, 4;
