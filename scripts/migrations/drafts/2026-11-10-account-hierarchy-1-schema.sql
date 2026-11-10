-- Account hierarchy, step 1 of 2: schema.  DRAFT — not run by scripts/migrate-db.mjs.
--
--   wealth_users                      (who)
--     └─ wealth_accounts              (one row per real account; user_id lives ONLY here)
--          ├─ subtype → wealth_account_subtypes → category CASA | INVESTMENT | LIABILITY
--          ├─ wealth_account_balances (cash / outstanding balance history)   PK (account_id, as_of)
--          ├─ wealth_holdings         (units of an instrument)               PK (account_id, instrument_id)
--          └─ wealth_transactions     (existing, already keyed by account_id)
--   wealth_instruments                (shared by all users: a stock / fund / metal exists once)
--     └─ wealth_instrument_prices     (price history, stored once per instrument) PK (instrument_id, as_of, source)
--
-- Additive only: new tables + new nullable column on wealth_accounts. Existing tables keep working
-- until the app is switched over; old tables are dropped in a later, separately approved step.

BEGIN;

-- 1. Type → subtype catalogue (reference data, no user_id).
CREATE TABLE IF NOT EXISTS wealth_account_subtypes (
  code       text PRIMARY KEY,
  category   text NOT NULL CHECK (category IN ('CASA', 'INVESTMENT', 'LIABILITY')),
  label      text NOT NULL,
  valuation  text NOT NULL CHECK (valuation IN ('balance', 'holdings')),
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO wealth_account_subtypes (code, category, label, valuation, sort_order) VALUES
  ('savings',        'CASA',       'Savings account',          'balance',  10),
  ('current',        'CASA',       'Current account',          'balance',  20),
  ('demat_equity',   'INVESTMENT', 'Stocks & ETFs (demat)',    'holdings', 30),
  ('mutual_fund',    'INVESTMENT', 'Mutual funds',             'holdings', 40),
  ('us_brokerage',   'INVESTMENT', 'US stocks & ETFs',         'holdings', 50),
  ('digital_gold',   'INVESTMENT', 'Digital gold',             'holdings', 60),
  ('digital_silver', 'INVESTMENT', 'Digital silver',           'holdings', 70),
  ('fixed_deposit',  'INVESTMENT', 'Fixed deposit',            'balance',  80),
  ('provident_fund', 'INVESTMENT', 'EPF / EPS / PPF',          'balance',  90),
  ('credit_card',    'LIABILITY',  'Credit card',              'balance', 100),
  ('credit_line',    'LIABILITY',  'Credit line',              'balance', 110),
  ('loan',           'LIABILITY',  'Loan',                     'balance', 120)
ON CONFLICT (code) DO UPDATE SET category = EXCLUDED.category, label = EXCLUDED.label,
  valuation = EXCLUDED.valuation, sort_order = EXCLUDED.sort_order;

-- 2. Accounts get a subtype (and through it, a category) plus an explicit lifecycle status.
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS subtype_code text REFERENCES wealth_account_subtypes(code);
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_accounts_status_check') THEN
    ALTER TABLE wealth_accounts ADD CONSTRAINT wealth_accounts_status_check CHECK (status IN ('active', 'closed', 'merged'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wealth_accounts_user_subtype_idx ON wealth_accounts (user_id, subtype_code) WHERE status = 'active';

-- 3. Instruments: one row per security / fund / metal, shared across users.
CREATE TABLE IF NOT EXISTS wealth_instruments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_class         text NOT NULL CHECK (asset_class IN ('indian_equity', 'indian_mutual_fund', 'us_equity', 'us_etf', 'precious_metal')),
  symbol              text NOT NULL,            -- LT, NVDA, GOLD, or AMFI scheme name/code
  name                text NOT NULL,
  currency            char(3) NOT NULL CHECK (currency IN ('INR', 'USD')),
  unit                text NOT NULL CHECK (unit IN ('share', 'unit', 'g')),
  price_source        text,
  price_source_symbol text,                     -- LT.NS, GC=F, MFAPI scheme code
  UNIQUE (asset_class, symbol)
);

-- 4. Price history, once per instrument. The latest price is a view, never a second table.
CREATE TABLE IF NOT EXISTS wealth_instrument_prices (
  instrument_id uuid NOT NULL REFERENCES wealth_instruments(id) ON DELETE CASCADE,
  as_of         timestamptz NOT NULL,
  source        text NOT NULL,
  price         numeric(24,10) NOT NULL CHECK (price > 0),
  fx_to_inr     numeric(12,6) CHECK (fx_to_inr > 0),   -- required to value USD prices in INR
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, as_of, source)
);

-- 5. Holdings: how many units of which instrument an account holds. One row per pair.
CREATE TABLE IF NOT EXISTS wealth_holdings (
  account_id     uuid NOT NULL REFERENCES wealth_accounts(id) ON DELETE CASCADE,
  instrument_id  uuid NOT NULL REFERENCES wealth_instruments(id) ON DELETE RESTRICT,
  quantity       numeric(24,8) NOT NULL CHECK (quantity > 0),
  invested_value numeric(20,4) CHECK (invested_value >= 0),   -- in the account currency
  as_of          timestamptz NOT NULL,
  source_snapshot_id uuid REFERENCES wealth_snapshots(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, instrument_id)
);
CREATE INDEX IF NOT EXISTS wealth_holdings_instrument_idx ON wealth_holdings (instrument_id);

-- 6. Balances: cash in CASA / FD / EPF / broker cash, or the outstanding amount of a liability.
--    History is kept; the latest row per account is a view. Currency comes from the account.
CREATE TABLE IF NOT EXISTS wealth_account_balances (
  account_id     uuid NOT NULL REFERENCES wealth_accounts(id) ON DELETE CASCADE,
  as_of          timestamptz NOT NULL,
  balance        numeric(20,4) NOT NULL,
  status         text NOT NULL DEFAULT 'reported' CHECK (status IN ('verified', 'reported', 'pending_reconciliation')),
  source_snapshot_id uuid REFERENCES wealth_snapshots(id) ON DELETE SET NULL,
  note           text,
  PRIMARY KEY (account_id, as_of)
);

-- 7. Read model: latest price, latest balance, value per account.
CREATE OR REPLACE VIEW wealth_v_latest_prices AS
SELECT DISTINCT ON (instrument_id) instrument_id, as_of, source, price, fx_to_inr, fetched_at
FROM wealth_instrument_prices
ORDER BY instrument_id, as_of DESC, fetched_at DESC;

CREATE OR REPLACE VIEW wealth_v_latest_balances AS
SELECT DISTINCT ON (account_id) account_id, as_of, balance, status, note
FROM wealth_account_balances
ORDER BY account_id, as_of DESC;

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
  WHERE x.account_id = a.id
) h ON true
WHERE a.status = 'active';

COMMIT;
