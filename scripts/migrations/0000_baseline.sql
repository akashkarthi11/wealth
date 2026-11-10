-- 0000 baseline: complete schema as of 2026-11-10, generated from the live catalog (see scripts/db/schema.sql).
-- Idempotent. Runs inside the migration runner transaction, so it has no BEGIN/COMMIT.

CREATE SEQUENCE IF NOT EXISTS wealth_price_history_id_seq AS bigint;

CREATE TABLE IF NOT EXISTS wealth_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  account_key text NOT NULL,
  bank_name text NOT NULL,
  account_name text NOT NULL,
  account_type text DEFAULT 'savings'::text NOT NULL,
  masked_identifier text,
  currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
  current_balance numeric(18,2),
  balance_as_of timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  balance_status text DEFAULT 'unknown'::text NOT NULL,
  CONSTRAINT wealth_accounts_balance_status_check CHECK ((balance_status = ANY (ARRAY['verified'::text, 'stale'::text, 'pending_reconciliation'::text, 'unknown'::text]))),
  CONSTRAINT wealth_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_accounts_user_account_key UNIQUE (user_id, account_key),
  CONSTRAINT wealth_accounts_user_id_id_key UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS wealth_category_symbols (
  user_id uuid NOT NULL,
  category_key text NOT NULL,
  display_symbol text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_category_symbols_nonempty CHECK (((length(TRIM(BOTH FROM display_symbol)) >= 1) AND (length(TRIM(BOTH FROM display_symbol)) <= 16))),
  CONSTRAINT wealth_category_symbols_pkey PRIMARY KEY (user_id, category_key)
);

CREATE TABLE IF NOT EXISTS wealth_email_imports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider text DEFAULT 'gmail'::text NOT NULL,
  message_id text NOT NULL,
  transaction_id uuid,
  import_status text DEFAULT 'imported'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_email_imports_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_email_imports_user_id_provider_message_id_key UNIQUE (user_id, provider, message_id)
);

CREATE TABLE IF NOT EXISTS wealth_interest_ledger (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  product_key text NOT NULL,
  account_key text NOT NULL,
  partition_key text DEFAULT 'main'::text NOT NULL,
  accrual_date date NOT NULL,
  principal numeric(24,8) NOT NULL,
  annual_rate numeric(12,8) NOT NULL,
  day_count integer NOT NULL,
  interest_amount numeric(24,8) NOT NULL,
  entry_type text NOT NULL,
  revision integer DEFAULT 1 NOT NULL,
  supersedes_id uuid,
  source_rate_id uuid,
  source_url text NOT NULL,
  calculation_status text DEFAULT 'estimated'::text NOT NULL,
  transaction_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  CONSTRAINT wealth_interest_ledger_annual_rate_check CHECK (((annual_rate >= (0)::numeric) AND (annual_rate <= (1)::numeric))),
  CONSTRAINT wealth_interest_ledger_calculation_status_check CHECK ((calculation_status = ANY (ARRAY['estimated'::text, 'confirmed'::text, 'corrected'::text, 'reversed'::text]))),
  CONSTRAINT wealth_interest_ledger_day_count_check CHECK ((day_count = ANY (ARRAY[365, 366]))),
  CONSTRAINT wealth_interest_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['accrual'::text, 'correction'::text, 'reversal'::text]))),
  CONSTRAINT wealth_interest_ledger_principal_check CHECK ((principal >= (0)::numeric)),
  CONSTRAINT wealth_interest_ledger_revision_check CHECK ((revision >= 1)),
  CONSTRAINT wealth_interest_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_interest_ledger_user_id_provider_product_key_account_key UNIQUE (user_id, provider, product_key, account_key, partition_key, accrual_date, revision)
);

CREATE TABLE IF NOT EXISTS wealth_interest_rates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  provider text NOT NULL,
  product_key text NOT NULL,
  annual_rate numeric(12,8) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  source_url text NOT NULL,
  source_checked_at timestamp with time zone DEFAULT now() NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  recorded_by text DEFAULT 'system'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  CONSTRAINT wealth_interest_rates_annual_rate_check CHECK (((annual_rate >= (0)::numeric) AND (annual_rate <= (1)::numeric))),
  CONSTRAINT wealth_interest_rates_check CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
  CONSTRAINT wealth_interest_rates_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS wealth_interest_statements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  product_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  statement_total numeric(18,2) NOT NULL,
  currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
  statement_label text NOT NULL,
  daily_breakdown jsonb DEFAULT '[]'::jsonb NOT NULL,
  source_type text DEFAULT 'user_screenshot'::text NOT NULL,
  source_files jsonb DEFAULT '[]'::jsonb NOT NULL,
  captured_at timestamp with time zone DEFAULT now() NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_interest_statements_statement_total_check CHECK ((statement_total >= (0)::numeric)),
  CONSTRAINT wealth_interest_statements_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_interest_statements_user_id_provider_product_key_per_key UNIQUE (user_id, provider, product_key, period_start, period_end, statement_label)
);

CREATE TABLE IF NOT EXISTS wealth_investment_assets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id uuid,
  asset_class text NOT NULL,
  symbol text,
  display_name text NOT NULL,
  quantity_unit text NOT NULL,
  price_currency character(3) NOT NULL,
  price_source text,
  price_source_symbol text,
  pricing_status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_investment_assets_status_check CHECK ((pricing_status = ANY (ARRAY['active'::text, 'pending'::text, 'manual'::text, 'unsupported'::text, 'stale'::text]))),
  CONSTRAINT wealth_investment_assets_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_investment_assets_position_id_key UNIQUE (position_id)
);

CREATE TABLE IF NOT EXISTS wealth_market_prices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  asset_id uuid NOT NULL,
  user_id uuid NOT NULL,
  unit_price numeric(24,10) NOT NULL,
  currency character(3) NOT NULL,
  source text NOT NULL,
  source_timestamp timestamp with time zone,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL,
  status text DEFAULT 'fresh'::text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT wealth_market_prices_status_check CHECK ((status = ANY (ARRAY['fresh'::text, 'stale'::text, 'error'::text, 'manual'::text]))),
  CONSTRAINT wealth_market_prices_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_market_prices_asset_id_key UNIQUE (asset_id)
);

CREATE TABLE IF NOT EXISTS wealth_payment_occurrences (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  due_date date NOT NULL,
  expected_amount numeric(18,2) NOT NULL,
  actual_amount numeric(18,2),
  status text DEFAULT 'planned'::text NOT NULL,
  transaction_id uuid,
  source_record_id uuid,
  paid_at timestamp with time zone,
  notes text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_payment_occurrences_actual_ck CHECK (((actual_amount IS NULL) OR (actual_amount >= (0)::numeric))),
  CONSTRAINT wealth_payment_occurrences_expected_ck CHECK ((expected_amount > (0)::numeric)),
  CONSTRAINT wealth_payment_occurrences_status_ck CHECK ((status = ANY (ARRAY['planned'::text, 'paid'::text, 'skipped'::text, 'cancelled'::text]))),
  CONSTRAINT wealth_payment_occurrences_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_payment_occurrences_due_uq UNIQUE (obligation_id, due_date)
);

CREATE TABLE IF NOT EXISTS wealth_planned_bills (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  amount numeric(14,2) NOT NULL,
  due_date date NOT NULL,
  category text DEFAULT 'Insurance'::text NOT NULL,
  account_id uuid,
  payee text,
  reference_masked text,
  recurrence text DEFAULT 'one_time'::text NOT NULL,
  status text DEFAULT 'planned'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  bill_key text,
  CONSTRAINT wealth_planned_bills_amount_check CHECK ((amount > (0)::numeric)),
  CONSTRAINT wealth_planned_bills_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'paid'::text, 'cancelled'::text]))),
  CONSTRAINT wealth_planned_bills_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_planned_bills_user_id_title_due_date_key UNIQUE (user_id, title, due_date)
);

CREATE TABLE IF NOT EXISTS wealth_positions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  category text NOT NULL,
  institution_name text,
  platform_name text,
  record_type text NOT NULL,
  name text NOT NULL,
  ticker text,
  currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
  quantity numeric(24,8),
  current_value numeric(20,4),
  invested_value numeric(20,4),
  balance_as_of timestamp with time zone,
  source_snapshot_id uuid,
  source_key text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_positions_category_check CHECK ((category = ANY (ARRAY['CASA'::text, 'INVESTMENT'::text, 'LIABILITY'::text]))),
  CONSTRAINT wealth_positions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS wealth_price_history (
  id bigint DEFAULT nextval('wealth_price_history_id_seq'::regclass) NOT NULL,
  asset_id uuid NOT NULL,
  user_id uuid NOT NULL,
  unit_price numeric(24,10) NOT NULL,
  currency character(3) NOT NULL,
  source text NOT NULL,
  source_timestamp timestamp with time zone,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT wealth_price_history_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS wealth_recurring_obligations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  obligation_key text NOT NULL,
  title text NOT NULL,
  obligation_type text DEFAULT 'other'::text NOT NULL,
  expected_amount numeric(18,2),
  amount_type text DEFAULT 'fixed'::text NOT NULL,
  frequency text DEFAULT 'one_time'::text NOT NULL,
  start_date date,
  next_due_date date,
  end_date date,
  account_id uuid,
  mandate_id uuid,
  source_type text DEFAULT 'manual'::text NOT NULL,
  source_record_id uuid,
  status text DEFAULT 'active'::text NOT NULL,
  notes text DEFAULT ''::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_recurring_obligations_amount_ck CHECK (((expected_amount IS NULL) OR (expected_amount > (0)::numeric))),
  CONSTRAINT wealth_recurring_obligations_amount_type_ck CHECK ((amount_type = ANY (ARRAY['fixed'::text, 'variable'::text, 'up_to'::text]))),
  CONSTRAINT wealth_recurring_obligations_frequency_ck CHECK ((frequency = ANY (ARRAY['one_time'::text, 'daily'::text, 'weekly'::text, 'monthly'::text, 'quarterly'::text, 'half_yearly'::text, 'yearly'::text, 'as_presented'::text, 'frequency_not_confirmed'::text]))),
  CONSTRAINT wealth_recurring_obligations_source_ck CHECK ((source_type = ANY (ARRAY['planned_bill'::text, 'subscription'::text, 'manual'::text]))),
  CONSTRAINT wealth_recurring_obligations_status_ck CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'cancelled'::text, 'completed'::text]))),
  CONSTRAINT wealth_recurring_obligations_type_ck CHECK ((obligation_type = ANY (ARRAY['rent'::text, 'utility'::text, 'insurance'::text, 'subscription'::text, 'savings'::text, 'loan'::text, 'investment'::text, 'other'::text]))),
  CONSTRAINT wealth_recurring_obligations_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_recurring_obligations_user_key_uq UNIQUE (user_id, obligation_key)
);

CREATE TABLE IF NOT EXISTS wealth_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  source_key text NOT NULL,
  source_name text NOT NULL,
  snapshot_date date NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_snapshots_user_id_source_key_key UNIQUE (user_id, source_key)
);

CREATE TABLE IF NOT EXISTS wealth_stock_advisor_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  run_at timestamp with time zone DEFAULT now() NOT NULL,
  report_text text DEFAULT ''::text NOT NULL,
  report_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_stock_advisor_reports_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS wealth_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider_key text NOT NULL,
  provider_name text NOT NULL,
  mandate_key text NOT NULL,
  amount numeric(14,2),
  amount_type text DEFAULT 'fixed'::text NOT NULL,
  frequency text DEFAULT 'as_presented'::text NOT NULL,
  source_account_id uuid,
  merchant_id text,
  status text DEFAULT 'active'::text NOT NULL,
  next_due_date date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  obligation_id uuid,
  CONSTRAINT wealth_subscriptions_amount_type_check CHECK ((amount_type = ANY (ARRAY['fixed'::text, 'up_to'::text, 'variable'::text]))),
  CONSTRAINT wealth_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'cancelled'::text]))),
  CONSTRAINT wealth_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_subscriptions_user_id_provider_key_mandate_key_key UNIQUE (user_id, provider_key, mandate_key)
);

CREATE TABLE IF NOT EXISTS wealth_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  template_key text NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  config jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_templates_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_templates_user_id_template_key_key UNIQUE (user_id, template_key)
);

CREATE TABLE IF NOT EXISTS wealth_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  category text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  amount numeric(16,2) NOT NULL,
  account text DEFAULT ''::text NOT NULL,
  occurred_on date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  account_id uuid,
  CONSTRAINT wealth_transactions_amount_check CHECK ((amount > (0)::numeric)),
  CONSTRAINT wealth_transactions_kind_check CHECK ((kind = ANY (ARRAY['income'::text, 'expense'::text, 'transfer'::text, 'investment'::text, 'liability'::text]))),
  CONSTRAINT wealth_transactions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS wealth_users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text DEFAULT 'user'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT wealth_users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text]))),
  CONSTRAINT wealth_users_pkey PRIMARY KEY (id),
  CONSTRAINT wealth_users_email_key UNIQUE (email)
);

ALTER SEQUENCE wealth_price_history_id_seq OWNED BY wealth_price_history.id;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_accounts_user_id_fkey' AND conrelid='public.wealth_accounts'::regclass) THEN
    ALTER TABLE wealth_accounts ADD CONSTRAINT wealth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_category_symbols_user_id_fkey' AND conrelid='public.wealth_category_symbols'::regclass) THEN
    ALTER TABLE wealth_category_symbols ADD CONSTRAINT wealth_category_symbols_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_email_imports_transaction_id_fkey' AND conrelid='public.wealth_email_imports'::regclass) THEN
    ALTER TABLE wealth_email_imports ADD CONSTRAINT wealth_email_imports_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES wealth_transactions(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_interest_ledger_source_rate_id_fkey' AND conrelid='public.wealth_interest_ledger'::regclass) THEN
    ALTER TABLE wealth_interest_ledger ADD CONSTRAINT wealth_interest_ledger_source_rate_id_fkey FOREIGN KEY (source_rate_id) REFERENCES wealth_interest_rates(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_interest_ledger_supersedes_id_fkey' AND conrelid='public.wealth_interest_ledger'::regclass) THEN
    ALTER TABLE wealth_interest_ledger ADD CONSTRAINT wealth_interest_ledger_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES wealth_interest_ledger(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_interest_ledger_transaction_id_fkey' AND conrelid='public.wealth_interest_ledger'::regclass) THEN
    ALTER TABLE wealth_interest_ledger ADD CONSTRAINT wealth_interest_ledger_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES wealth_transactions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_interest_ledger_user_id_fkey' AND conrelid='public.wealth_interest_ledger'::regclass) THEN
    ALTER TABLE wealth_interest_ledger ADD CONSTRAINT wealth_interest_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_interest_statements_user_id_fkey' AND conrelid='public.wealth_interest_statements'::regclass) THEN
    ALTER TABLE wealth_interest_statements ADD CONSTRAINT wealth_interest_statements_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_investment_assets_position_id_fkey' AND conrelid='public.wealth_investment_assets'::regclass) THEN
    ALTER TABLE wealth_investment_assets ADD CONSTRAINT wealth_investment_assets_position_id_fkey FOREIGN KEY (position_id) REFERENCES wealth_positions(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_investment_assets_user_id_fkey' AND conrelid='public.wealth_investment_assets'::regclass) THEN
    ALTER TABLE wealth_investment_assets ADD CONSTRAINT wealth_investment_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_market_prices_asset_id_fkey' AND conrelid='public.wealth_market_prices'::regclass) THEN
    ALTER TABLE wealth_market_prices ADD CONSTRAINT wealth_market_prices_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES wealth_investment_assets(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_market_prices_user_id_fkey' AND conrelid='public.wealth_market_prices'::regclass) THEN
    ALTER TABLE wealth_market_prices ADD CONSTRAINT wealth_market_prices_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_payment_occurrences_obligation_id_fkey' AND conrelid='public.wealth_payment_occurrences'::regclass) THEN
    ALTER TABLE wealth_payment_occurrences ADD CONSTRAINT wealth_payment_occurrences_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES wealth_recurring_obligations(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_payment_occurrences_transaction_id_fkey' AND conrelid='public.wealth_payment_occurrences'::regclass) THEN
    ALTER TABLE wealth_payment_occurrences ADD CONSTRAINT wealth_payment_occurrences_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES wealth_transactions(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_payment_occurrences_user_id_fkey' AND conrelid='public.wealth_payment_occurrences'::regclass) THEN
    ALTER TABLE wealth_payment_occurrences ADD CONSTRAINT wealth_payment_occurrences_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_planned_bills_account_id_fkey' AND conrelid='public.wealth_planned_bills'::regclass) THEN
    ALTER TABLE wealth_planned_bills ADD CONSTRAINT wealth_planned_bills_account_id_fkey FOREIGN KEY (account_id) REFERENCES wealth_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_planned_bills_user_id_fkey' AND conrelid='public.wealth_planned_bills'::regclass) THEN
    ALTER TABLE wealth_planned_bills ADD CONSTRAINT wealth_planned_bills_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_positions_source_snapshot_id_fkey' AND conrelid='public.wealth_positions'::regclass) THEN
    ALTER TABLE wealth_positions ADD CONSTRAINT wealth_positions_source_snapshot_id_fkey FOREIGN KEY (source_snapshot_id) REFERENCES wealth_snapshots(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_positions_user_id_fkey' AND conrelid='public.wealth_positions'::regclass) THEN
    ALTER TABLE wealth_positions ADD CONSTRAINT wealth_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_price_history_asset_id_fkey' AND conrelid='public.wealth_price_history'::regclass) THEN
    ALTER TABLE wealth_price_history ADD CONSTRAINT wealth_price_history_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES wealth_investment_assets(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_price_history_user_id_fkey' AND conrelid='public.wealth_price_history'::regclass) THEN
    ALTER TABLE wealth_price_history ADD CONSTRAINT wealth_price_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_recurring_obligations_account_id_fkey' AND conrelid='public.wealth_recurring_obligations'::regclass) THEN
    ALTER TABLE wealth_recurring_obligations ADD CONSTRAINT wealth_recurring_obligations_account_id_fkey FOREIGN KEY (account_id) REFERENCES wealth_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_recurring_obligations_mandate_id_fkey' AND conrelid='public.wealth_recurring_obligations'::regclass) THEN
    ALTER TABLE wealth_recurring_obligations ADD CONSTRAINT wealth_recurring_obligations_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES wealth_subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_recurring_obligations_user_id_fkey' AND conrelid='public.wealth_recurring_obligations'::regclass) THEN
    ALTER TABLE wealth_recurring_obligations ADD CONSTRAINT wealth_recurring_obligations_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_snapshots_user_id_fkey' AND conrelid='public.wealth_snapshots'::regclass) THEN
    ALTER TABLE wealth_snapshots ADD CONSTRAINT wealth_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_stock_advisor_reports_user_id_fkey' AND conrelid='public.wealth_stock_advisor_reports'::regclass) THEN
    ALTER TABLE wealth_stock_advisor_reports ADD CONSTRAINT wealth_stock_advisor_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_subscriptions_obligation_id_fkey' AND conrelid='public.wealth_subscriptions'::regclass) THEN
    ALTER TABLE wealth_subscriptions ADD CONSTRAINT wealth_subscriptions_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES wealth_recurring_obligations(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_subscriptions_source_account_id_fkey' AND conrelid='public.wealth_subscriptions'::regclass) THEN
    ALTER TABLE wealth_subscriptions ADD CONSTRAINT wealth_subscriptions_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES wealth_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_subscriptions_user_id_fkey' AND conrelid='public.wealth_subscriptions'::regclass) THEN
    ALTER TABLE wealth_subscriptions ADD CONSTRAINT wealth_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_templates_user_id_fkey' AND conrelid='public.wealth_templates'::regclass) THEN
    ALTER TABLE wealth_templates ADD CONSTRAINT wealth_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_transactions_account_id_fkey' AND conrelid='public.wealth_transactions'::regclass) THEN
    ALTER TABLE wealth_transactions ADD CONSTRAINT wealth_transactions_account_id_fkey FOREIGN KEY (user_id, account_id) REFERENCES wealth_accounts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wealth_transactions_user_id_fkey' AND conrelid='public.wealth_transactions'::regclass) THEN
    ALTER TABLE wealth_transactions ADD CONSTRAINT wealth_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES wealth_users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_accounts_user_bank_masked_uidx ON wealth_accounts USING btree (user_id, bank_name, masked_identifier) WHERE (masked_identifier IS NOT NULL);
CREATE INDEX IF NOT EXISTS wealth_accounts_user_type_idx ON wealth_accounts USING btree (user_id, account_type);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_category_symbols_user_category_uidx ON wealth_category_symbols USING btree (user_id, category_key);
CREATE INDEX IF NOT EXISTS wealth_interest_ledger_account_idx ON wealth_interest_ledger USING btree (user_id, account_key, partition_key, accrual_date DESC);
CREATE INDEX IF NOT EXISTS wealth_interest_ledger_date_idx ON wealth_interest_ledger USING btree (user_id, accrual_date DESC);
CREATE INDEX IF NOT EXISTS wealth_interest_rates_lookup_idx ON wealth_interest_rates USING btree (provider, product_key, effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_interest_rates_period_uq ON wealth_interest_rates USING btree (provider, product_key, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_investment_assets_history_symbol_uidx ON wealth_investment_assets USING btree (user_id, symbol) WHERE (position_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_investment_assets_position_id_uidx ON wealth_investment_assets USING btree (position_id);
CREATE INDEX IF NOT EXISTS wealth_investment_assets_user_class_idx ON wealth_investment_assets USING btree (user_id, asset_class);
CREATE INDEX IF NOT EXISTS wealth_payment_occurrences_obligation_due_idx ON wealth_payment_occurrences USING btree (obligation_id, due_date DESC);
CREATE INDEX IF NOT EXISTS wealth_payment_occurrences_user_due_idx ON wealth_payment_occurrences USING btree (user_id, status, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_planned_bills_user_bill_due_uq ON wealth_planned_bills USING btree (user_id, bill_key, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_positions_source_unique_idx ON wealth_positions USING btree (user_id, source_snapshot_id, record_type, name);
CREATE INDEX IF NOT EXISTS wealth_positions_user_asof_idx ON wealth_positions USING btree (user_id, balance_as_of DESC);
CREATE INDEX IF NOT EXISTS wealth_positions_user_category_idx ON wealth_positions USING btree (user_id, category, record_type);
CREATE INDEX IF NOT EXISTS wealth_price_history_asset_time_idx ON wealth_price_history USING btree (asset_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS wealth_price_history_source_time_idx ON wealth_price_history USING btree (user_id, source_timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_recurring_obligations_source_uq ON wealth_recurring_obligations USING btree (source_type, source_record_id) WHERE (source_record_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS wealth_recurring_obligations_user_due_idx ON wealth_recurring_obligations USING btree (user_id, status, next_due_date);
CREATE INDEX IF NOT EXISTS wealth_stock_advisor_reports_user_run_idx ON wealth_stock_advisor_reports USING btree (user_id, run_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_subscriptions_user_mandate_uq ON wealth_subscriptions USING btree (user_id, mandate_key) WHERE (mandate_key IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_subscriptions_user_provider_uq ON wealth_subscriptions USING btree (user_id, provider_key);
CREATE INDEX IF NOT EXISTS wealth_transactions_account_id_idx ON wealth_transactions USING btree (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS wealth_transactions_user_id_id_key ON wealth_transactions USING btree (user_id, id);
CREATE INDEX IF NOT EXISTS wealth_tx_user_date ON wealth_transactions USING btree (user_id, occurred_on DESC);

