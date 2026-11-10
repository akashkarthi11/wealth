-- Account hierarchy, step 2 of 2: copy today's data into the new structure.  DRAFT — not run by migrate-db.
-- Requires step 1. Idempotent (ON CONFLICT DO NOTHING). Old tables are NOT modified except:
--   * wealth_accounts.subtype_code is filled in,
--   * the duplicate 'fixed-deposits' account is marked status='merged' (kept for audit, not deleted).
-- Ends with a reconciliation check that aborts the whole transaction if anything was not carried over.

BEGIN;

-- 0. Mapping from legacy position record types to subtypes.
CREATE TEMP TABLE _subtype_map (record_type text PRIMARY KEY, subtype text NOT NULL) ON COMMIT DROP;
INSERT INTO _subtype_map VALUES
  ('EQUITY','demat_equity'), ('MUTUAL_FUND','mutual_fund'), ('US_EQUITY','us_brokerage'), ('ETF','us_brokerage'),
  ('GOLD','digital_gold'), ('SILVER','digital_silver'), ('FIXED_DEPOSIT','fixed_deposit'),
  ('EPF','provident_fund'), ('CREDIT_CARD','credit_card');

-- Active legacy positions with everything needed to place them in the hierarchy.
CREATE TEMP TABLE _pos ON COMMIT DROP AS
SELECT p.*, m.subtype, s.valuation, a.id AS asset_id, a.asset_class, a.quantity_unit,
       a.price_source, a.price_source_symbol,
       coalesce(p.ticker, CASE WHEN a.asset_class = 'precious_metal' THEN upper(p.record_type) ELSE p.name END) AS instrument_symbol,
       CASE WHEN s.valuation = 'holdings'
            THEN lower(regexp_replace(p.platform_name, '[^A-Za-z0-9]+', '-', 'g')) || '-' || m.subtype
            ELSE lower(regexp_replace(coalesce(p.institution_name, p.platform_name), '[^A-Za-z0-9]+', '-', 'g'))
                 || '-' || m.subtype || '-' || lower(regexp_replace(p.name, '[^A-Za-z0-9]+', '-', 'g')) END AS account_key_new
FROM wealth_positions p
JOIN _subtype_map m ON m.record_type = p.record_type
JOIN wealth_account_subtypes s ON s.code = m.subtype
LEFT JOIN wealth_investment_assets a ON a.position_id = p.id
WHERE p.record_type NOT LIKE '%\_ARCHIVED';

-- 1. Existing bank / card accounts get their subtype; the FD "account" duplicating FD positions is merged.
UPDATE wealth_accounts SET subtype_code = account_type, updated_at = now()
WHERE subtype_code IS NULL AND account_type IN ('savings', 'current', 'credit_card');

UPDATE wealth_accounts a SET status = 'merged', updated_at = now()
WHERE a.account_type = 'fixed_deposit' AND a.status = 'active'
  AND EXISTS (SELECT 1 FROM _pos p WHERE p.user_id = a.user_id AND p.subtype = 'fixed_deposit');

-- 2. Investment accounts: one per platform+subtype for holdings, one per FD / EPF record.
--    Credit-card liabilities are NOT new accounts: they attach to the existing card account (step 6).
INSERT INTO wealth_accounts (user_id, account_key, bank_name, account_name, account_type, subtype_code, currency, balance_status)
SELECT DISTINCT ON (p.user_id, p.account_key_new)
       p.user_id, p.account_key_new,
       coalesce(CASE WHEN p.valuation = 'balance' THEN p.institution_name END, p.platform_name),
       CASE WHEN p.valuation = 'holdings' THEN s.label ELSE p.name END,
       p.subtype, p.subtype,
       CASE WHEN p.subtype = 'us_brokerage' THEN 'USD' ELSE 'INR' END,
       'unknown'
FROM _pos p JOIN wealth_account_subtypes s ON s.code = p.subtype
WHERE p.subtype <> 'credit_card'
ORDER BY p.user_id, p.account_key_new
ON CONFLICT (user_id, account_key) DO NOTHING;

-- 3. Instruments (shared): one row per security / fund / metal.
INSERT INTO wealth_instruments (asset_class, symbol, name, currency, unit, price_source, price_source_symbol)
SELECT DISTINCT ON (p.asset_class, p.instrument_symbol)
       p.asset_class, p.instrument_symbol, p.name, p.currency, p.quantity_unit, p.price_source, p.price_source_symbol
FROM _pos p
WHERE p.valuation = 'holdings' AND p.asset_id IS NOT NULL
ORDER BY p.asset_class, p.instrument_symbol
ON CONFLICT (asset_class, symbol) DO NOTHING;

-- 4. Holdings.
INSERT INTO wealth_holdings (account_id, instrument_id, quantity, invested_value, as_of, source_snapshot_id)
SELECT acc.id, i.id, p.quantity, p.invested_value, coalesce(p.balance_as_of, p.updated_at), p.source_snapshot_id
FROM _pos p
JOIN wealth_instruments i ON i.asset_class = p.asset_class AND i.symbol = p.instrument_symbol
JOIN wealth_accounts acc ON acc.user_id = p.user_id AND acc.account_key = p.account_key_new
WHERE p.valuation = 'holdings' AND p.quantity > 0
ON CONFLICT (account_id, instrument_id) DO NOTHING;

-- 5. Prices: full history plus the current latest row, stored once per instrument.
INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr, fetched_at)
SELECT i.id, coalesce(h.source_timestamp, h.recorded_at), h.source, h.unit_price,
       NULLIF(h.metadata->>'fx_to_inr', '')::numeric, h.recorded_at
FROM wealth_price_history h
JOIN _pos p ON p.asset_id = h.asset_id
JOIN wealth_instruments i ON i.asset_class = p.asset_class AND i.symbol = p.instrument_symbol
WHERE h.currency = i.currency
ON CONFLICT (instrument_id, as_of, source) DO NOTHING;

INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr, fetched_at)
SELECT i.id, coalesce(m.source_timestamp, m.fetched_at), m.source, m.unit_price,
       NULLIF(m.metadata->>'fx_to_inr', '')::numeric, m.fetched_at
FROM wealth_market_prices m
JOIN _pos p ON p.asset_id = m.asset_id
JOIN wealth_instruments i ON i.asset_class = p.asset_class AND i.symbol = p.instrument_symbol
WHERE m.currency = i.currency
ON CONFLICT (instrument_id, as_of, source) DO NOTHING;

-- 6. Balances.
-- 6a. Bank accounts (CASA) and cards that already carry a balance.
INSERT INTO wealth_account_balances (account_id, as_of, balance, status)
SELECT a.id, a.balance_as_of, a.current_balance, CASE WHEN a.balance_status = 'verified' THEN 'verified' ELSE 'reported' END
FROM wealth_accounts a
WHERE a.status = 'active' AND a.subtype_code IS NOT NULL
  AND a.current_balance IS NOT NULL AND a.balance_as_of IS NOT NULL
ON CONFLICT (account_id, as_of) DO NOTHING;

-- 6b. FD and EPF records.
INSERT INTO wealth_account_balances (account_id, as_of, balance, status, source_snapshot_id, note)
SELECT acc.id, coalesce(p.balance_as_of, p.updated_at), p.current_value,
       CASE WHEN p.metadata->>'reconciliation_status' IN ('pending_reconciliation', 'balance_reconciliation_required') THEN 'pending_reconciliation'
            ELSE 'reported' END,
       p.source_snapshot_id, p.metadata->>'warning'
FROM _pos p JOIN wealth_accounts acc ON acc.user_id = p.user_id AND acc.account_key = p.account_key_new
WHERE p.valuation = 'balance' AND p.subtype <> 'credit_card' AND p.current_value IS NOT NULL
ON CONFLICT (account_id, as_of) DO NOTHING;

-- 6c. Credit-card outstanding attaches to the existing card account (matched on the masked number).
INSERT INTO wealth_account_balances (account_id, as_of, balance, status, source_snapshot_id, note)
SELECT acc.id, coalesce(p.balance_as_of, p.updated_at), p.current_value, 'reported', p.source_snapshot_id,
       'Outstanding at last statement, cycle liability ' || coalesce(p.metadata->>'cycle_liability', 'n/a')
FROM _pos p
JOIN wealth_accounts acc ON acc.user_id = p.user_id AND acc.subtype_code = 'credit_card' AND acc.status = 'active'
 AND acc.masked_identifier LIKE '%' || (p.metadata->>'masked_card')
WHERE p.subtype = 'credit_card' AND p.current_value IS NOT NULL
ON CONFLICT (account_id, as_of) DO NOTHING;

-- 6d. Broker cash (INDmoney buying power) currently only lives on the archived US aggregate row.
INSERT INTO wealth_account_balances (account_id, as_of, balance, status, source_snapshot_id, note)
SELECT acc.id, coalesce(old.balance_as_of, old.updated_at), (old.metadata->'cash_balance'->>'buying_power_usd')::numeric,
       'reported', old.source_snapshot_id, 'Buying power (uninvested cash)'
FROM wealth_positions old
JOIN wealth_accounts acc ON acc.user_id = old.user_id AND acc.subtype_code = 'us_brokerage'
 AND acc.bank_name = old.platform_name AND acc.status = 'active'
WHERE old.record_type = 'US_PORTFOLIO_AGGREGATE_ARCHIVED'
  AND NULLIF(old.metadata->'cash_balance'->>'buying_power_usd', '') IS NOT NULL
ON CONFLICT (account_id, as_of) DO NOTHING;

-- 7. Reconciliation: every active legacy position must now exist exactly once in the new model.
DO $$
DECLARE missing_holdings int; missing_balances int;
BEGIN
  SELECT count(*) INTO missing_holdings FROM _pos p
  WHERE p.valuation = 'holdings' AND NOT EXISTS (
    SELECT 1 FROM wealth_holdings h JOIN wealth_accounts a ON a.id = h.account_id
    JOIN wealth_instruments i ON i.id = h.instrument_id
    WHERE a.user_id = p.user_id AND a.account_key = p.account_key_new
      AND i.asset_class = p.asset_class AND i.symbol = p.instrument_symbol AND h.quantity = p.quantity);
  SELECT count(*) INTO missing_balances FROM _pos p
  WHERE p.valuation = 'balance' AND NOT EXISTS (
    SELECT 1 FROM wealth_account_balances b JOIN wealth_accounts a ON a.id = b.account_id
    WHERE a.user_id = p.user_id AND b.balance = p.current_value
      AND (a.account_key = p.account_key_new OR (p.subtype = 'credit_card' AND a.subtype_code = 'credit_card')));
  IF missing_holdings > 0 OR missing_balances > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % holding(s) and % balance(s) not carried over', missing_holdings, missing_balances;
  END IF;
END $$;

COMMIT;
