-- 0008: TSD Claude Plan 3 — Phases 1, 3, 5 and 6 (schema part). Additive only: new columns, tables, functions
-- and triggers. Existing rows are only linked or marked (rate period end dates, a price hold); nothing is removed.

-- ── Phase 1: data-quality corrections ────────────────────────────────────────────────────────────────────────
-- TR3-1.3 A transaction can be marked as a duplicate of the row that is kept. Marked rows stay in the table and
-- are left out of totals.
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS duplicate_of uuid;
ALTER TABLE wealth_transactions ADD COLUMN IF NOT EXISTS duplicate_marked_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_owner_duplicate_fk') THEN
    ALTER TABLE wealth_transactions ADD CONSTRAINT wealth_transactions_owner_duplicate_fk
      FOREIGN KEY (user_id, duplicate_of) REFERENCES wealth_transactions(user_id, id) ON DELETE SET NULL (duplicate_of);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_not_self_duplicate') THEN
    ALTER TABLE wealth_transactions ADD CONSTRAINT wealth_transactions_not_self_duplicate CHECK (duplicate_of IS NULL OR duplicate_of <> id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS wealth_transactions_duplicate_idx ON wealth_transactions (duplicate_of) WHERE duplicate_of IS NOT NULL;

-- TR3-1.4 Fixed-deposit terms on the FD account (nullable; only meaningful for subtype fixed_deposit).
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS fd_principal numeric(18,2);
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS fd_booked_on date;
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS fd_maturity_on date;
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS fd_payout text;
ALTER TABLE wealth_accounts ADD COLUMN IF NOT EXISTS fd_compounding text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_accounts_fd_terms_check') THEN
    ALTER TABLE wealth_accounts ADD CONSTRAINT wealth_accounts_fd_terms_check CHECK (
      (fd_principal IS NULL OR fd_principal > 0)
      AND (fd_maturity_on IS NULL OR fd_booked_on IS NULL OR fd_maturity_on > fd_booked_on)
      AND (fd_payout IS NULL OR fd_payout IN ('cumulative', 'monthly', 'quarterly', 'yearly'))
      AND (fd_compounding IS NULL OR fd_compounding IN ('simple', 'monthly', 'quarterly', 'half_yearly', 'yearly')));
  END IF;
END $$;

-- TR3-1.1 / DQ-1 Prices for an instrument can be put on hold (with a reason) while its quantity is checked.
ALTER TABLE wealth_instruments ADD COLUMN IF NOT EXISTS price_hold_reason text;
UPDATE wealth_instruments SET price_hold_reason = 'Units under review (DQ-1): stored 29.02 vs about 69.7 implied by the saved value'
WHERE asset_class = 'indian_mutual_fund' AND name ILIKE 'Nippon India Large Cap%' AND price_hold_reason IS NULL;

-- TR3-1.6 / DQ-6 One open rate period per product: give an older open period the end date of the day before the
-- newer one starts (rows kept, note appended).
UPDATE wealth_interest_rates r
SET effective_to = (SELECT min(n.effective_from) FROM wealth_interest_rates n
                    WHERE n.product_key = r.product_key AND n.effective_to IS NULL AND n.effective_from > r.effective_from) - 1,
    notes = r.notes || ' [closed by migration 0008: superseded by a later open period]'
WHERE r.effective_to IS NULL
  AND EXISTS (SELECT 1 FROM wealth_interest_rates n WHERE n.product_key = r.product_key AND n.effective_to IS NULL AND n.effective_from > r.effective_from);

-- ── Phase 3: interest — explicit account ↔ product links ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wealth_interest_links (
  account_id    uuid NOT NULL REFERENCES wealth_accounts(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES wealth_interest_products(id) ON DELETE CASCADE,
  partition_key text NOT NULL DEFAULT 'main',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, product_id, partition_key)
);
CREATE INDEX IF NOT EXISTS wealth_interest_links_product_idx ON wealth_interest_links (product_id);
-- Links already proven by ledger rows …
INSERT INTO wealth_interest_links (account_id, product_id, partition_key)
SELECT DISTINCT account_id, product_id, partition_key FROM wealth_interest_ledger
WHERE account_id IS NOT NULL AND product_id IS NOT NULL
ON CONFLICT DO NOTHING;
-- … and the mapping the daily agent used (only where both the account and the product exist).
INSERT INTO wealth_interest_links (account_id, product_id)
SELECT a.id, p.id
FROM (VALUES ('slice-savings', 'slice-savings-3731'), ('atom-savings', 'atom-savings'),
             ('slice-fd', 'slice-fixed_deposit-slice-fd'), ('angel-one-fd', 'angel-one-fixed_deposit-angel-one-fd-aggregate-')) m(product_key, account_key)
JOIN wealth_interest_products p ON p.product_key = m.product_key
JOIN wealth_accounts a ON a.account_key = m.account_key AND a.status = 'active'
ON CONFLICT DO NOTHING;

-- Rate periods recorded through /api/interest/rates keep their evidence text.
ALTER TABLE wealth_interest_rates ADD COLUMN IF NOT EXISTS evidence text;

-- ── Phase 5: legacy bills and mandates keep the obligations model in step ───────────────────────────────────
CREATE OR REPLACE FUNCTION wealth_obligation_type(p_text text, p_default text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN lower(p_text) LIKE '%rent%' THEN 'rent'
    WHEN lower(p_text) LIKE '%utilit%' OR lower(p_text) LIKE '%electric%' THEN 'utility'
    WHEN lower(p_text) LIKE '%insurance%' OR lower(p_text) LIKE '%lic%' THEN 'insurance'
    WHEN lower(p_text) LIKE '%saving%' OR lower(p_text) LIKE '%deposit%' THEN 'savings'
    WHEN lower(p_text) LIKE '%loan%' OR lower(p_text) LIKE '%emi%' THEN 'loan'
    WHEN lower(p_text) LIKE '%investment%' THEN 'investment'
    ELSE p_default END
$fn$;

-- Planned bill → its obligation ('bill:<bill_key>') is created when missing; the bill points at it.
CREATE OR REPLACE FUNCTION wealth_fill_bill_obligation() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_key text := 'bill:' || COALESCE(NULLIF(NEW.bill_key, ''), NEW.id::text);
BEGIN
  BEGIN
    IF NEW.obligation_id IS NULL THEN
      INSERT INTO wealth_recurring_obligations (user_id, obligation_key, title, obligation_type, expected_amount, amount_type,
        frequency, start_date, next_due_date, account_id, source_type, status, notes)
      VALUES (NEW.user_id, v_key, NEW.title, wealth_obligation_type(NEW.category, 'other'), NEW.amount, 'fixed',
        CASE WHEN NEW.recurrence IN ('one_time','daily','weekly','monthly','quarterly','half_yearly','yearly') THEN NEW.recurrence ELSE 'one_time' END,
        NEW.due_date, CASE WHEN NEW.status = 'planned' THEN NEW.due_date END, NEW.account_id, 'planned_bill',
        CASE NEW.status WHEN 'cancelled' THEN 'cancelled' WHEN 'paid' THEN 'completed' ELSE 'active' END,
        COALESCE(NEW.payee, ''))
      ON CONFLICT (user_id, obligation_key) DO NOTHING;
      SELECT id INTO NEW.obligation_id FROM wealth_recurring_obligations WHERE user_id = NEW.user_id AND obligation_key = v_key;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_planned_bills', NEW.id::text, 'obligation: ' || SQLERRM);
  END;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS wealth_planned_bills_fill_obligation ON wealth_planned_bills;
CREATE TRIGGER wealth_planned_bills_fill_obligation BEFORE INSERT OR UPDATE OF bill_key, obligation_id ON wealth_planned_bills
  FOR EACH ROW EXECUTE FUNCTION wealth_fill_bill_obligation();

-- After a bill is written: one payment occurrence per bill, status kept in step, next due date refreshed.
CREATE OR REPLACE FUNCTION wealth_trg_bill_occurrence() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.obligation_id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO wealth_payment_occurrences (user_id, obligation_id, due_date, expected_amount, status, planned_bill_id, source_record_id)
    VALUES (NEW.user_id, NEW.obligation_id, NEW.due_date, NEW.amount,
            CASE NEW.status WHEN 'paid' THEN 'paid' WHEN 'cancelled' THEN 'cancelled' ELSE 'planned' END, NEW.id, NEW.id)
    ON CONFLICT DO NOTHING;
    UPDATE wealth_payment_occurrences SET
      status = CASE NEW.status WHEN 'paid' THEN 'paid' WHEN 'cancelled' THEN 'cancelled' ELSE 'planned' END,
      actual_amount = CASE WHEN NEW.status = 'paid' THEN coalesce(actual_amount, NEW.amount) END,
      paid_at = CASE WHEN NEW.status = 'paid' THEN coalesce(paid_at, now()) END,
      updated_at = now()
    WHERE planned_bill_id = NEW.id
      AND status IS DISTINCT FROM (CASE NEW.status WHEN 'paid' THEN 'paid' WHEN 'cancelled' THEN 'cancelled' ELSE 'planned' END);
    UPDATE wealth_recurring_obligations o SET
      next_due_date = (SELECT min(b.due_date) FROM wealth_planned_bills b WHERE b.obligation_id = o.id AND b.status = 'planned'),
      updated_at = now()
    WHERE o.id = NEW.obligation_id AND o.source_type = 'planned_bill';
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_planned_bills', NEW.id::text, 'occurrence: ' || SQLERRM);
  END;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS wealth_planned_bills_sync_occurrence ON wealth_planned_bills;
CREATE TRIGGER wealth_planned_bills_sync_occurrence AFTER INSERT OR UPDATE OF status, due_date, amount, obligation_id ON wealth_planned_bills
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_bill_occurrence();

-- Mandate → its own obligation ('mandate:<provider>:<mandate>') when it is not linked yet; status/amount kept in step.
CREATE OR REPLACE FUNCTION wealth_trg_subscription_obligation() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_key text := 'mandate:' || NEW.provider_key || ':' || NEW.mandate_key; v_id uuid;
BEGIN
  BEGIN
    IF NEW.obligation_id IS NULL THEN
      INSERT INTO wealth_recurring_obligations (user_id, obligation_key, title, obligation_type, expected_amount, amount_type,
        frequency, next_due_date, account_id, mandate_id, source_type, source_record_id, status, notes)
      VALUES (NEW.user_id, v_key, NEW.provider_name, wealth_obligation_type(NEW.provider_name, 'subscription'), NULLIF(NEW.amount, 0),
        CASE WHEN NEW.amount_type IN ('fixed','variable','up_to') THEN NEW.amount_type ELSE 'fixed' END,
        CASE WHEN NEW.frequency IN ('one_time','daily','weekly','monthly','quarterly','half_yearly','yearly','as_presented','frequency_not_confirmed') THEN NEW.frequency ELSE 'frequency_not_confirmed' END,
        NEW.next_due_date, NEW.source_account_id, NEW.id, 'subscription', NEW.id,
        CASE NEW.status WHEN 'active' THEN 'active' WHEN 'paused' THEN 'paused' ELSE 'cancelled' END, COALESCE(NEW.merchant_id, ''))
      ON CONFLICT (user_id, obligation_key) DO NOTHING;
      SELECT id INTO v_id FROM wealth_recurring_obligations WHERE user_id = NEW.user_id AND obligation_key = v_key;
      UPDATE wealth_subscriptions SET obligation_id = v_id WHERE id = NEW.id AND obligation_id IS NULL;
    ELSE
      UPDATE wealth_recurring_obligations SET
        title = NEW.provider_name, expected_amount = NULLIF(NEW.amount, 0), next_due_date = NEW.next_due_date,
        status = CASE NEW.status WHEN 'active' THEN 'active' WHEN 'paused' THEN 'paused' ELSE 'cancelled' END,
        account_id = coalesce(NEW.source_account_id, account_id), updated_at = now()
      WHERE id = NEW.obligation_id AND source_type = 'subscription'
        AND (title, expected_amount, next_due_date, status) IS DISTINCT FROM
            (NEW.provider_name, NULLIF(NEW.amount, 0), NEW.next_due_date, CASE NEW.status WHEN 'active' THEN 'active' WHEN 'paused' THEN 'paused' ELSE 'cancelled' END);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO wealth_sync_issues (source_table, source_id, message) VALUES ('wealth_subscriptions', NEW.id::text, 'obligation: ' || SQLERRM);
  END;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS wealth_subscriptions_sync_obligation ON wealth_subscriptions;
CREATE TRIGGER wealth_subscriptions_sync_obligation AFTER INSERT OR UPDATE OF provider_name, amount, next_due_date, status, source_account_id, obligation_id ON wealth_subscriptions
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_subscription_obligation();

-- ── Phase 6: audit trail of every change to a financial row ─────────────────────────────────────────────────
-- Append-only. actor = the API's `wealth.actor` setting (owner / agent / cron) or 'external' for direct SQL.
CREATE TABLE IF NOT EXISTS wealth_audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  table_name text NOT NULL,
  row_id     text,
  before     jsonb,
  after      jsonb
);
CREATE INDEX IF NOT EXISTS wealth_audit_log_table_row_idx ON wealth_audit_log (table_name, row_id, at DESC);
CREATE INDEX IF NOT EXISTS wealth_audit_log_at_idx ON wealth_audit_log (at DESC);

CREATE OR REPLACE FUNCTION wealth_trg_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_before jsonb; v_after jsonb; v_row jsonb; v_id text;
BEGIN
  BEGIN
    IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN v_after := to_jsonb(NEW); END IF;
    IF TG_OP = 'UPDATE' AND v_before = v_after THEN RETURN NULL; END IF;
    v_row := coalesce(v_after, v_before);
    v_id := coalesce(v_row->>'id', concat_ws('/', v_row->>'account_id', v_row->>'instrument_id', v_row->>'as_of'));
    INSERT INTO wealth_audit_log (actor, action, table_name, row_id, before, after)
    VALUES (coalesce(NULLIF(current_setting('wealth.actor', true), ''), 'external'), lower(TG_OP), TG_TABLE_NAME, v_id, v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wealth audit failed on %: %', TG_TABLE_NAME, SQLERRM;   -- auditing never blocks the write
  END;
  RETURN NULL;
END $fn$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wealth_accounts', 'wealth_account_balances', 'wealth_holdings', 'wealth_transactions',
                           'wealth_interest_rates', 'wealth_interest_ledger', 'wealth_positions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit()', t || '_audit', t);
  END LOOP;
END $$;

-- ── Phase 6: backups are recorded as job runs ('backup'); nothing else to store here. ───────────────────────
