-- 0018: one data-version counter for exact Redis caching (owner 2026-11-11: "use redis more efficiently to increase speed").
-- Every INSERT / UPDATE / DELETE statement on a data table — from the app, the nightly jobs or an external writer
-- (ChatGPT, direct SQL) — bumps wealth_data_version.version. API responses are cached in Redis together with the version
-- they were built from and are served only while the version is unchanged, so a cached page is never stale.
-- Statement-level triggers: a bulk import bumps once per statement. Logs and bookkeeping tables are left out.
-- Additive: one table, one function, triggers. No data changed.
CREATE TABLE IF NOT EXISTS wealth_data_version (
  id          int PRIMARY KEY CHECK (id = 1),
  version     bigint NOT NULL DEFAULT 0,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wealth_data_version (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION wealth_bump_data_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE wealth_data_version SET version = version + 1, changed_at = now() WHERE id = 1;
  RETURN NULL;
END $fn$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wealth_users', 'wealth_accounts', 'wealth_account_balances', 'wealth_account_subtypes', 'wealth_holdings', 'wealth_instruments',
    'wealth_instrument_prices', 'wealth_investment_assets', 'wealth_market_prices', 'wealth_price_history', 'wealth_positions',
    'wealth_transactions', 'wealth_snapshots', 'wealth_templates', 'wealth_category_symbols', 'wealth_interest_ledger',
    'wealth_interest_links', 'wealth_interest_products', 'wealth_interest_rates', 'wealth_interest_statements',
    'wealth_planned_bills', 'wealth_subscriptions', 'wealth_recurring_obligations', 'wealth_payment_occurrences',
    'wealth_broker_ledger', 'wealth_reward_programs', 'wealth_reward_balances', 'wealth_reward_events',
    'wealth_stock_advisor_reports', 'wealth_email_imports', 'wealth_data_quality_acceptances'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_data_version', t);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version()', t || '_data_version', t);
    END IF;
  END LOOP;
END $$;
