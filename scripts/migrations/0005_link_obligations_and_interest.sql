-- 0005: replace text and untyped links with real foreign keys (TSD Phase 6, TR-6.1 / TR-6.3, additive part).
-- Nothing is dropped: the old text columns stay so external writers keep working, and triggers fill the
-- new keys for rows those writers insert. Converting the legacy tables to views is a later, approved step.

-- A. Planned bills are instances of a recurring obligation: bill.obligation_id -> obligation.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_planned_bills_user_id_id_key') THEN
    ALTER TABLE wealth_planned_bills ADD CONSTRAINT wealth_planned_bills_user_id_id_key UNIQUE (user_id, id);
  END IF;
END $$;
ALTER TABLE wealth_planned_bills ADD COLUMN IF NOT EXISTS obligation_id uuid;
UPDATE wealth_planned_bills b SET obligation_id = o.id
FROM wealth_recurring_obligations o
WHERE b.obligation_id IS NULL AND o.user_id = b.user_id
  AND o.obligation_key = 'bill:' || COALESCE(NULLIF(b.bill_key, ''), b.id::text);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_planned_bills_owner_obligation_fk') THEN
    ALTER TABLE wealth_planned_bills ADD CONSTRAINT wealth_planned_bills_owner_obligation_fk
      FOREIGN KEY (user_id, obligation_id) REFERENCES wealth_recurring_obligations(user_id, id) ON DELETE SET NULL (obligation_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wealth_planned_bills_obligation_idx ON wealth_planned_bills (obligation_id);

-- B. A payment occurrence that came from a planned bill points at it by a typed key (was source_record_id).
ALTER TABLE wealth_payment_occurrences ADD COLUMN IF NOT EXISTS planned_bill_id uuid;
UPDATE wealth_payment_occurrences p SET planned_bill_id = b.id
FROM wealth_planned_bills b
WHERE p.planned_bill_id IS NULL AND p.source_record_id = b.id AND b.user_id = p.user_id;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_payment_occurrences_owner_bill_fk') THEN
    ALTER TABLE wealth_payment_occurrences ADD CONSTRAINT wealth_payment_occurrences_owner_bill_fk
      FOREIGN KEY (user_id, planned_bill_id) REFERENCES wealth_planned_bills(user_id, id) ON DELETE SET NULL (planned_bill_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_payment_occurrences_bill_uq ON wealth_payment_occurrences (planned_bill_id) WHERE planned_bill_id IS NOT NULL;

-- C. Interest products named once. product_key is the identity (provider text is spelled inconsistently).
CREATE TABLE IF NOT EXISTS wealth_interest_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key text NOT NULL UNIQUE,
  provider    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wealth_interest_products (product_key, provider)
SELECT DISTINCT ON (product_key) product_key, provider FROM (
  SELECT product_key, provider, 1 AS pref FROM wealth_interest_rates
  UNION ALL SELECT product_key, provider, 2 FROM wealth_interest_ledger
  UNION ALL SELECT product_key, provider, 3 FROM wealth_interest_statements
) s WHERE product_key IS NOT NULL
ORDER BY product_key, pref
ON CONFLICT (product_key) DO NOTHING;

ALTER TABLE wealth_interest_rates      ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES wealth_interest_products(id);
ALTER TABLE wealth_interest_ledger     ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES wealth_interest_products(id);
ALTER TABLE wealth_interest_statements ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES wealth_interest_products(id);
ALTER TABLE wealth_interest_ledger     ADD COLUMN IF NOT EXISTS account_id uuid;
UPDATE wealth_interest_rates t      SET product_id = p.id FROM wealth_interest_products p WHERE t.product_id IS NULL AND p.product_key = t.product_key;
UPDATE wealth_interest_ledger t     SET product_id = p.id FROM wealth_interest_products p WHERE t.product_id IS NULL AND p.product_key = t.product_key;
UPDATE wealth_interest_statements t SET product_id = p.id FROM wealth_interest_products p WHERE t.product_id IS NULL AND p.product_key = t.product_key;
UPDATE wealth_interest_ledger t SET account_id = a.id
FROM wealth_accounts a WHERE t.account_id IS NULL AND a.user_id = t.user_id AND a.account_key = t.account_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_interest_ledger_owner_account_fk') THEN
    ALTER TABLE wealth_interest_ledger ADD CONSTRAINT wealth_interest_ledger_owner_account_fk
      FOREIGN KEY (user_id, account_id) REFERENCES wealth_accounts(user_id, id) ON DELETE SET NULL (account_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wealth_interest_ledger_product_idx ON wealth_interest_ledger (product_id, accrual_date DESC);
CREATE INDEX IF NOT EXISTS wealth_interest_statements_product_idx ON wealth_interest_statements (product_id);
CREATE INDEX IF NOT EXISTS wealth_interest_rates_product_idx ON wealth_interest_rates (product_id, effective_from DESC);

-- D. Keep the typed keys filled for rows written by external jobs that only know the text keys.
CREATE OR REPLACE FUNCTION wealth_fill_interest_keys() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.product_id IS NULL AND NEW.product_key IS NOT NULL THEN
    INSERT INTO wealth_interest_products (product_key, provider) VALUES (NEW.product_key, NEW.provider)
    ON CONFLICT (product_key) DO NOTHING;
    SELECT id INTO NEW.product_id FROM wealth_interest_products WHERE product_key = NEW.product_key;
  END IF;
  -- Nested IF: only the ledger has account columns, and SQL does not guarantee AND short-circuits.
  IF TG_TABLE_NAME = 'wealth_interest_ledger' THEN
    IF NEW.account_id IS NULL AND NEW.account_key IS NOT NULL THEN
      SELECT id INTO NEW.account_id FROM wealth_accounts WHERE user_id = NEW.user_id AND account_key = NEW.account_key;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION wealth_fill_bill_obligation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.obligation_id IS NULL THEN
    SELECT id INTO NEW.obligation_id FROM wealth_recurring_obligations
    WHERE user_id = NEW.user_id AND obligation_key = 'bill:' || COALESCE(NULLIF(NEW.bill_key, ''), NEW.id::text);
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS wealth_interest_rates_fill_keys ON wealth_interest_rates;
CREATE TRIGGER wealth_interest_rates_fill_keys BEFORE INSERT OR UPDATE OF product_key ON wealth_interest_rates
  FOR EACH ROW EXECUTE FUNCTION wealth_fill_interest_keys();
DROP TRIGGER IF EXISTS wealth_interest_ledger_fill_keys ON wealth_interest_ledger;
CREATE TRIGGER wealth_interest_ledger_fill_keys BEFORE INSERT OR UPDATE OF product_key, account_key ON wealth_interest_ledger
  FOR EACH ROW EXECUTE FUNCTION wealth_fill_interest_keys();
DROP TRIGGER IF EXISTS wealth_interest_statements_fill_keys ON wealth_interest_statements;
CREATE TRIGGER wealth_interest_statements_fill_keys BEFORE INSERT OR UPDATE OF product_key ON wealth_interest_statements
  FOR EACH ROW EXECUTE FUNCTION wealth_fill_interest_keys();
DROP TRIGGER IF EXISTS wealth_planned_bills_fill_obligation ON wealth_planned_bills;
CREATE TRIGGER wealth_planned_bills_fill_obligation BEFORE INSERT OR UPDATE OF bill_key ON wealth_planned_bills
  FOR EACH ROW EXECUTE FUNCTION wealth_fill_bill_obligation();
