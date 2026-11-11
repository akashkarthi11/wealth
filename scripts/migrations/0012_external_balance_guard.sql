-- 0012: guard bank balances against external writers (TSD Claude Plan 4, Part 0 — TR4-0.1).
-- "External" = a direct SQL session that does not set `wealth.actor` (the audit log records it as 'external'; this is
-- how the ChatGPT task writes). The app, owner repairs, agents and cron always set an actor and are not affected.
-- Incident 2026-11-11: an external writer set Slice Savings to 'pending_reconciliation' (it left the totals), then
-- moved the balance back to an older date (dashboard and balance history disagreed by ₹5,000). Both are now refused
-- with a clear error, matching rules.md §2. Additive: one function, two triggers; no data changed.
CREATE OR REPLACE FUNCTION wealth_trg_external_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NULLIF(current_setting('wealth.actor', true), '') IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'wealth_accounts' THEN
    IF NEW.balance_status = 'pending_reconciliation'
       AND (TG_OP = 'INSERT' OR OLD.balance_status IS DISTINCT FROM NEW.balance_status) THEN
      RAISE EXCEPTION 'external writer: balance_status pending_reconciliation is not allowed (rules.md §2: use verified with bank evidence, or stale for an estimate)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.balance_as_of IS NOT NULL AND NEW.balance_as_of IS NOT NULL AND NEW.balance_as_of < OLD.balance_as_of THEN
      RAISE EXCEPTION 'external writer: a balance cannot move back in time (balance_as_of % -> %); record a newer balance instead', OLD.balance_as_of, NEW.balance_as_of
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'pending_reconciliation' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    RAISE EXCEPTION 'external writer: balance status pending_reconciliation is not allowed (rules.md §2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS wealth_accounts_external_guard ON wealth_accounts;
CREATE TRIGGER wealth_accounts_external_guard BEFORE INSERT OR UPDATE OF balance_status, balance_as_of ON wealth_accounts
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_external_balance_guard();

DROP TRIGGER IF EXISTS wealth_account_balances_external_guard ON wealth_account_balances;
CREATE TRIGGER wealth_account_balances_external_guard BEFORE INSERT OR UPDATE OF status ON wealth_account_balances
  FOR EACH ROW EXECUTE FUNCTION wealth_trg_external_balance_guard();
