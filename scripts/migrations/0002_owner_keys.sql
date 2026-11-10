-- 0002: owner-matching keys and duplicate prevention (TSD Phase 4, TR-4.1 to TR-4.3).
-- Keys and constraints only: no rows are inserted, updated or deleted.

-- 1. Parents expose (user_id, id) so children can reference both columns.
--    wealth_accounts and wealth_transactions already have this.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_positions_user_id_id_key') THEN
    ALTER TABLE wealth_positions ADD CONSTRAINT wealth_positions_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_investment_assets_user_id_id_key') THEN
    ALTER TABLE wealth_investment_assets ADD CONSTRAINT wealth_investment_assets_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_recurring_obligations_user_id_id_key') THEN
    ALTER TABLE wealth_recurring_obligations ADD CONSTRAINT wealth_recurring_obligations_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_subscriptions_user_id_id_key') THEN
    ALTER TABLE wealth_subscriptions ADD CONSTRAINT wealth_subscriptions_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_snapshots_user_id_id_key') THEN
    ALTER TABLE wealth_snapshots ADD CONSTRAINT wealth_snapshots_user_id_id_key UNIQUE (user_id, id);
  END IF;
END $$;

-- 2. Same-owner foreign keys. "SET NULL (col)" clears only the reference, never user_id (PostgreSQL 15+).
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('wealth_investment_assets',     'wealth_investment_assets_owner_position_fk',  '(user_id, position_id) REFERENCES wealth_positions(user_id, id) ON DELETE CASCADE'),
    ('wealth_market_prices',         'wealth_market_prices_owner_asset_fk',         '(user_id, asset_id) REFERENCES wealth_investment_assets(user_id, id) ON DELETE CASCADE'),
    ('wealth_price_history',         'wealth_price_history_owner_asset_fk',         '(user_id, asset_id) REFERENCES wealth_investment_assets(user_id, id) ON DELETE CASCADE'),
    ('wealth_positions',             'wealth_positions_owner_snapshot_fk',          '(user_id, source_snapshot_id) REFERENCES wealth_snapshots(user_id, id) ON DELETE SET NULL (source_snapshot_id)'),
    ('wealth_planned_bills',         'wealth_planned_bills_owner_account_fk',       '(user_id, account_id) REFERENCES wealth_accounts(user_id, id) ON DELETE SET NULL (account_id)'),
    ('wealth_subscriptions',         'wealth_subscriptions_owner_account_fk',       '(user_id, source_account_id) REFERENCES wealth_accounts(user_id, id) ON DELETE SET NULL (source_account_id)'),
    ('wealth_subscriptions',         'wealth_subscriptions_owner_obligation_fk',    '(user_id, obligation_id) REFERENCES wealth_recurring_obligations(user_id, id) ON DELETE SET NULL (obligation_id)'),
    ('wealth_recurring_obligations', 'wealth_recurring_obligations_owner_account_fk','(user_id, account_id) REFERENCES wealth_accounts(user_id, id) ON DELETE SET NULL (account_id)'),
    ('wealth_recurring_obligations', 'wealth_recurring_obligations_owner_mandate_fk','(user_id, mandate_id) REFERENCES wealth_subscriptions(user_id, id) ON DELETE SET NULL (mandate_id)'),
    ('wealth_payment_occurrences',   'wealth_payment_occurrences_owner_obligation_fk','(user_id, obligation_id) REFERENCES wealth_recurring_obligations(user_id, id) ON DELETE CASCADE'),
    ('wealth_payment_occurrences',   'wealth_payment_occurrences_owner_tx_fk',      '(user_id, transaction_id) REFERENCES wealth_transactions(user_id, id) ON DELETE SET NULL (transaction_id)'),
    ('wealth_email_imports',         'wealth_email_imports_owner_tx_fk',            '(user_id, transaction_id) REFERENCES wealth_transactions(user_id, id) ON DELETE SET NULL (transaction_id)'),
    ('wealth_interest_ledger',       'wealth_interest_ledger_owner_tx_fk',          '(user_id, transaction_id) REFERENCES wealth_transactions(user_id, id)')
  ) AS t(tbl, name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID', fk.tbl, fk.name, fk.def);
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tbl, fk.name);
  END LOOP;
END $$;

-- 3. No duplicate business rows.
-- One active position per holding (archived rows are exempt).
CREATE UNIQUE INDEX IF NOT EXISTS wealth_positions_active_holding_uq
  ON wealth_positions (user_id, category, record_type, coalesce(platform_name, ''), lower(coalesce(ticker, name)))
  WHERE record_type NOT LIKE '%\_ARCHIVED';

-- One Stock Advisor report per run.
CREATE UNIQUE INDEX IF NOT EXISTS wealth_stock_advisor_reports_user_run_uq
  ON wealth_stock_advisor_reports (user_id, run_at);

-- Stable import reference for transactions (statement line, email id, bank ref). Optional column;
-- when set it can never repeat, which is how imports stay idempotent without blocking two genuine
-- identical purchases on the same day.
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_transactions_user_external_ref_uq
  ON wealth_transactions (user_id, external_ref) WHERE external_ref IS NOT NULL;

-- 4. Drop indexes that exactly duplicate a constraint index.
--    (The old migrate-db.mjs re-created the first two on every deploy; the versioned runner does not.)
DROP INDEX IF EXISTS wealth_investment_assets_position_id_uidx;   -- = wealth_investment_assets_position_id_key
DROP INDEX IF EXISTS wealth_category_symbols_user_category_uidx;  -- = wealth_category_symbols_pkey
DROP INDEX IF EXISTS wealth_interest_rates_lookup_idx;            -- = wealth_interest_rates_period_uq
DROP INDEX IF EXISTS wealth_stock_advisor_reports_user_run_idx;   -- = wealth_stock_advisor_reports_user_run_uq (added above)
DROP INDEX IF EXISTS wealth_payment_occurrences_obligation_due_idx; -- = wealth_payment_occurrences_due_uq

-- 5. The single-column foreign keys are now implied by the composite ones; drop them so each
--    relationship is declared once. (wealth_transactions/accounts already use the composite form.)
ALTER TABLE wealth_investment_assets    DROP CONSTRAINT IF EXISTS wealth_investment_assets_position_id_fkey;
ALTER TABLE wealth_market_prices        DROP CONSTRAINT IF EXISTS wealth_market_prices_asset_id_fkey;
ALTER TABLE wealth_price_history        DROP CONSTRAINT IF EXISTS wealth_price_history_asset_id_fkey;
ALTER TABLE wealth_positions            DROP CONSTRAINT IF EXISTS wealth_positions_source_snapshot_id_fkey;
ALTER TABLE wealth_planned_bills        DROP CONSTRAINT IF EXISTS wealth_planned_bills_account_id_fkey;
ALTER TABLE wealth_subscriptions        DROP CONSTRAINT IF EXISTS wealth_subscriptions_source_account_id_fkey;
ALTER TABLE wealth_subscriptions        DROP CONSTRAINT IF EXISTS wealth_subscriptions_obligation_id_fkey;
ALTER TABLE wealth_recurring_obligations DROP CONSTRAINT IF EXISTS wealth_recurring_obligations_account_id_fkey;
ALTER TABLE wealth_recurring_obligations DROP CONSTRAINT IF EXISTS wealth_recurring_obligations_mandate_id_fkey;
ALTER TABLE wealth_payment_occurrences  DROP CONSTRAINT IF EXISTS wealth_payment_occurrences_obligation_id_fkey;
ALTER TABLE wealth_payment_occurrences  DROP CONSTRAINT IF EXISTS wealth_payment_occurrences_transaction_id_fkey;
ALTER TABLE wealth_email_imports        DROP CONSTRAINT IF EXISTS wealth_email_imports_transaction_id_fkey;
ALTER TABLE wealth_interest_ledger      DROP CONSTRAINT IF EXISTS wealth_interest_ledger_transaction_id_fkey;

