-- 0006: keep the account model (v2) in step with writes to the legacy tables (TSD Claude Plan 2, Phase B).
-- Additive only: new columns, a sync-issue log, functions and triggers. No row is deleted; a holding that is
-- sold or archived is marked status='closed'. A failed sync never blocks the legacy write: it is logged in
-- wealth_sync_issues and reported by /api/health.

-- 1. Holdings can be closed (never deleted) and remember the legacy position they mirror.
ALTER TABLE wealth_holdings ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE wealth_holdings ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE wealth_holdings ADD COLUMN IF NOT EXISTS legacy_position_id uuid REFERENCES wealth_positions(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_holdings_status_check') THEN
    ALTER TABLE wealth_holdings ADD CONSTRAINT wealth_holdings_status_check CHECK (status IN ('active', 'closed'));
  END IF;
  -- quantity must be positive while active; a closed holding keeps its last quantity (or 0).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_holdings_quantity_check') THEN
    ALTER TABLE wealth_holdings DROP CONSTRAINT wealth_holdings_quantity_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_holdings_quantity_active_check') THEN
    ALTER TABLE wealth_holdings ADD CONSTRAINT wealth_holdings_quantity_active_check CHECK (quantity > 0 OR (status = 'closed' AND quantity >= 0));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wealth_holdings_legacy_position_idx ON wealth_holdings (legacy_position_id);

-- 2. Sync problems are recorded, never silently dropped.
CREATE TABLE IF NOT EXISTS wealth_sync_issues (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  source_table text NOT NULL,
  source_id    text,
  message      text NOT NULL
);
CREATE INDEX IF NOT EXISTS wealth_sync_issues_time_idx ON wealth_sync_issues (occurred_at DESC);

-- 3. Mapping rules shared with the 0004 backfill.
CREATE OR REPLACE FUNCTION wealth_legacy_subtype(p_record_type text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE p_record_type
    WHEN 'EQUITY' THEN 'demat_equity' WHEN 'MUTUAL_FUND' THEN 'mutual_fund'
    WHEN 'US_EQUITY' THEN 'us_brokerage' WHEN 'ETF' THEN 'us_brokerage'
    WHEN 'GOLD' THEN 'digital_gold' WHEN 'SILVER' THEN 'digital_silver'
    WHEN 'FIXED_DEPOSIT' THEN 'fixed_deposit' WHEN 'EPF' THEN 'provident_fund'
    WHEN 'CREDIT_CARD' THEN 'credit_card' ELSE NULL END
$fn$;

CREATE OR REPLACE FUNCTION wealth_slug(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', '-', 'g'))
$fn$;

-- Link existing holdings to the positions they were copied from (by the same keys 0004 used).
UPDATE wealth_holdings h SET legacy_position_id = p.id
FROM wealth_positions p
JOIN wealth_investment_assets ia ON ia.position_id = p.id
JOIN wealth_accounts acc ON acc.user_id = p.user_id
  AND acc.account_key = wealth_slug(p.platform_name) || '-' || wealth_legacy_subtype(p.record_type)
JOIN wealth_instruments i ON i.asset_class = ia.asset_class
  AND i.symbol = coalesce(p.ticker, CASE WHEN ia.asset_class = 'precious_metal' THEN upper(p.record_type) ELSE p.name END)
WHERE h.legacy_position_id IS NULL AND h.account_id = acc.id AND h.instrument_id = i.id
  AND p.record_type NOT LIKE '%\_ARCHIVED';

-- 4. Copy one legacy position into the account model. Idempotent; inserts and marks only.
CREATE OR REPLACE FUNCTION wealth_sync_position(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  p wealth_positions%ROWTYPE;
  ia wealth_investment_assets%ROWTYPE;
  v_subtype text; v_valuation text; v_key text; v_bank text; v_name text;
  v_account uuid; v_instrument uuid; v_symbol text; v_status text;
BEGIN
  SELECT * INTO p FROM wealth_positions WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Archived, emptied or no-longer-held positions: close the mirrored holding (row kept).
  IF p.record_type LIKE '%\_ARCHIVED' OR p.quantity IS NULL OR p.quantity <= 0 THEN
    UPDATE wealth_holdings SET status = 'closed', closed_at = coalesce(closed_at, now()),
           quantity = CASE WHEN p.quantity IS NOT NULL AND p.quantity >= 0 THEN p.quantity ELSE quantity END
    WHERE legacy_position_id = p.id AND status = 'active';
    IF p.record_type LIKE '%\_ARCHIVED' THEN RETURN; END IF;
  END IF;

  v_subtype := wealth_legacy_subtype(p.record_type);
  IF v_subtype IS NULL THEN RETURN; END IF;               -- not part of the account model
  SELECT valuation INTO v_valuation FROM wealth_account_subtypes WHERE code = v_subtype;

  -- Find or create the account.
  IF v_subtype = 'credit_card' THEN
    SELECT id INTO v_account FROM wealth_accounts
    WHERE user_id = p.user_id AND subtype_code = 'credit_card' AND status = 'active'
      AND p.metadata->>'masked_card' IS NOT NULL AND masked_identifier LIKE '%' || (p.metadata->>'masked_card')
    LIMIT 1;
    IF v_account IS NULL THEN
      INSERT INTO wealth_sync_issues (source_table, source_id, message)
      VALUES ('wealth_positions', p.id::text, 'credit-card position has no matching card account (masked_card ' || coalesce(p.metadata->>'masked_card', 'missing') || ')');
      RETURN;
    END IF;
  ELSE
    IF v_valuation = 'holdings' THEN
      v_bank := p.platform_name;
      v_key := wealth_slug(p.platform_name) || '-' || v_subtype;
      SELECT label INTO v_name FROM wealth_account_subtypes WHERE code = v_subtype;
    ELSE
      v_bank := coalesce(p.institution_name, p.platform_name);
      v_key := wealth_slug(v_bank) || '-' || v_subtype || '-' || wealth_slug(p.name);
      v_name := p.name;
    END IF;
    IF v_bank IS NULL THEN
      INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_positions', p.id::text, 'position has no platform or institution name');
      RETURN;
    END IF;
    INSERT INTO wealth_accounts (user_id, account_key, bank_name, account_name, account_type, subtype_code, currency, balance_status)
    VALUES (p.user_id, v_key, v_bank, v_name, v_subtype, v_subtype, CASE WHEN v_subtype = 'us_brokerage' THEN 'USD' ELSE 'INR' END, 'unknown')
    ON CONFLICT (user_id, account_key) DO NOTHING;
    SELECT id INTO v_account FROM wealth_accounts WHERE user_id = p.user_id AND account_key = v_key;
  END IF;

  IF v_valuation = 'balance' THEN
    IF p.current_value IS NULL THEN RETURN; END IF;
    v_status := CASE WHEN p.metadata->>'reconciliation_status' IN ('pending_reconciliation', 'balance_reconciliation_required')
                     THEN 'pending_reconciliation' ELSE 'reported' END;
    INSERT INTO wealth_account_balances (account_id, as_of, balance, status, source_snapshot_id, note)
    SELECT v_account, coalesce(p.balance_as_of, p.updated_at, now()), p.current_value, v_status, p.source_snapshot_id, p.metadata->>'warning'
    WHERE NOT EXISTS (SELECT 1 FROM wealth_v_latest_balances b WHERE b.account_id = v_account
                        AND b.balance = p.current_value AND b.status = v_status)   -- unchanged value: nothing new to record
    ON CONFLICT (account_id, as_of) DO NOTHING;
    RETURN;
  END IF;

  -- Holdings: needs the pricing asset to know the instrument; the asset trigger retries when it appears.
  IF p.quantity IS NULL OR p.quantity <= 0 THEN RETURN; END IF;
  SELECT * INTO ia FROM wealth_investment_assets WHERE position_id = p.id;
  IF NOT FOUND THEN RETURN; END IF;
  v_symbol := coalesce(p.ticker, CASE WHEN ia.asset_class = 'precious_metal' THEN upper(p.record_type) ELSE p.name END);
  INSERT INTO wealth_instruments (asset_class, symbol, name, currency, unit, price_source, price_source_symbol)
  VALUES (ia.asset_class, v_symbol, p.name, p.currency, ia.quantity_unit, ia.price_source, ia.price_source_symbol)
  ON CONFLICT (asset_class, symbol) DO NOTHING;
  SELECT id INTO v_instrument FROM wealth_instruments WHERE asset_class = ia.asset_class AND symbol = v_symbol;

  INSERT INTO wealth_holdings (account_id, instrument_id, quantity, invested_value, as_of, source_snapshot_id, legacy_position_id, status)
  VALUES (v_account, v_instrument, p.quantity, p.invested_value, coalesce(p.balance_as_of, p.updated_at, now()), p.source_snapshot_id, p.id, 'active')
  ON CONFLICT (account_id, instrument_id) DO UPDATE SET
    quantity = EXCLUDED.quantity, invested_value = EXCLUDED.invested_value, as_of = EXCLUDED.as_of,
    source_snapshot_id = coalesce(EXCLUDED.source_snapshot_id, wealth_holdings.source_snapshot_id),
    legacy_position_id = EXCLUDED.legacy_position_id, status = 'active', closed_at = NULL;
END $fn$;

-- 5. Triggers. Each catches its own errors so the legacy write always succeeds; failures are logged.
CREATE OR REPLACE FUNCTION wealth_trg_sync_position() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_id uuid;
BEGIN
  -- Everything runs inside the exception block: nothing here may ever fail the legacy write.
  BEGIN
    -- Nested IF: each table has its own key column, and SQL does not guarantee short-circuit evaluation.
    IF TG_TABLE_NAME = 'wealth_investment_assets' THEN
      v_id := NEW.position_id;
    ELSE
      v_id := NEW.id;
    END IF;
    IF v_id IS NOT NULL THEN
      PERFORM wealth_sync_position(v_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES (TG_TABLE_NAME, v_id::text, SQLERRM);
  END;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS wealth_positions_sync_v2 ON wealth_positions;
CREATE TRIGGER wealth_positions_sync_v2 AFTER INSERT OR UPDATE ON wealth_positions
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_sync_position();
DROP TRIGGER IF EXISTS wealth_investment_assets_sync_v2 ON wealth_investment_assets;
CREATE TRIGGER wealth_investment_assets_sync_v2 AFTER INSERT OR UPDATE OF position_id, asset_class, symbol, price_source_symbol ON wealth_investment_assets
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_sync_position();

-- Bank/card accounts written by legacy jobs: give them a subtype, and record each new balance in history.
CREATE OR REPLACE FUNCTION wealth_trg_account_subtype() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.subtype_code IS NULL AND NEW.status = 'active' AND NEW.account_type IN ('savings', 'current', 'credit_card') THEN
    NEW.subtype_code := NEW.account_type;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS wealth_accounts_set_subtype ON wealth_accounts;
CREATE TRIGGER wealth_accounts_set_subtype BEFORE INSERT OR UPDATE OF account_type ON wealth_accounts
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_account_subtype();

CREATE OR REPLACE FUNCTION wealth_trg_account_balance() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.subtype_code IS NULL OR NEW.status <> 'active' OR NEW.current_balance IS NULL OR NEW.balance_as_of IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.current_balance IS NOT DISTINCT FROM NEW.current_balance
     AND OLD.balance_as_of IS NOT DISTINCT FROM NEW.balance_as_of
     AND OLD.balance_status IS NOT DISTINCT FROM NEW.balance_status THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO wealth_account_balances (account_id, as_of, balance, status, note)
    VALUES (NEW.id, NEW.balance_as_of, NEW.current_balance,
            CASE WHEN NEW.balance_status = 'verified' THEN 'verified'
                 WHEN NEW.balance_status = 'pending_reconciliation' THEN 'pending_reconciliation' ELSE 'reported' END,
            'from wealth_accounts')
    ON CONFLICT (account_id, as_of) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_accounts', NEW.id::text, SQLERRM);
  END;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS wealth_accounts_sync_balance ON wealth_accounts;
CREATE TRIGGER wealth_accounts_sync_balance AFTER INSERT OR UPDATE OF current_balance, balance_as_of, balance_status, subtype_code ON wealth_accounts
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_account_balance();

-- Fresh legacy prices are mirrored into the instrument price history (same as_of + source never duplicates).
CREATE OR REPLACE FUNCTION wealth_trg_mirror_price() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_instrument uuid; v_currency text; v_fx numeric;
BEGIN
  IF NEW.status <> 'fresh' OR NEW.unit_price IS NULL OR NEW.unit_price <= 0 THEN RETURN NULL; END IF;
  BEGIN
    SELECT i.id, trim(i.currency) INTO v_instrument, v_currency
    FROM wealth_investment_assets ia
    JOIN wealth_positions p ON p.id = ia.position_id
    JOIN wealth_instruments i ON i.asset_class = ia.asset_class
      AND i.symbol = coalesce(p.ticker, CASE WHEN ia.asset_class = 'precious_metal' THEN upper(p.record_type) ELSE p.name END)
    WHERE ia.id = NEW.asset_id;
    IF v_instrument IS NULL OR v_currency IS DISTINCT FROM trim(NEW.currency) THEN RETURN NULL; END IF;
    v_fx := NULLIF(NEW.metadata->>'fx_to_inr', '')::numeric;
    IF v_currency = 'USD' AND coalesce(v_fx, 0) <= 0 THEN RETURN NULL; END IF;   -- a USD price without its rate is not usable
    INSERT INTO wealth_instrument_prices (instrument_id, as_of, source, price, fx_to_inr, fetched_at)
    VALUES (v_instrument, coalesce(NEW.source_timestamp, NEW.fetched_at), NEW.source, NEW.unit_price,
            CASE WHEN v_currency = 'USD' THEN v_fx END, NEW.fetched_at)
    ON CONFLICT (instrument_id, as_of, source) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_market_prices', NEW.asset_id::text, SQLERRM);
  END;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS wealth_market_prices_mirror_v2 ON wealth_market_prices;
CREATE TRIGGER wealth_market_prices_mirror_v2 AFTER INSERT OR UPDATE ON wealth_market_prices
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_mirror_price();

-- 6. Read model ignores closed holdings.
CREATE OR REPLACE VIEW wealth_v_account_values AS
SELECT a.user_id, s.category, s.code AS subtype, a.id AS account_id, a.bank_name AS institution, a.account_name,
       a.currency,
       b.balance AS cash_or_outstanding, b.as_of AS balance_as_of, b.status AS balance_status,
       h.holdings_value, h.holdings_value_inr, h.holdings_priced, h.holdings_total
FROM wealth_accounts a
JOIN wealth_account_subtypes s ON s.code = a.subtype_code
LEFT JOIN wealth_v_latest_balances b ON b.account_id = a.id
LEFT JOIN LATERAL (
  SELECT sum(x.quantity * p.price) AS holdings_value,
         sum(x.quantity * p.price * CASE WHEN i.currency = 'INR' THEN 1 ELSE p.fx_to_inr END) AS holdings_value_inr,
         count(p.price) AS holdings_priced,
         count(*) AS holdings_total
  FROM wealth_holdings x
  JOIN wealth_instruments i ON i.id = x.instrument_id
  LEFT JOIN wealth_v_latest_prices p ON p.instrument_id = x.instrument_id
  WHERE x.account_id = a.id AND x.status = 'active'
) h ON true
WHERE a.status = 'active';

-- 7. Catch up anything written to the legacy tables between 0004 and now (idempotent; inserts and marks only).
SELECT wealth_sync_position(id) FROM wealth_positions;
