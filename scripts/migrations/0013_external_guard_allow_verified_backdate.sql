-- 0013: refine the 0012 external-writer guard (owner 2026-11-11: "my chatgpt run the task so it need to write in db").
-- A back-dated balance is still refused for estimates, but ALLOWED when it is 'verified' (bank evidence), e.g. a
-- screenshot from yesterday afternoon recorded after the nightly job stamped the account "end of yesterday".
-- pending_reconciliation stays refused. Prices, Gmail transactions, email imports and advisor reports were never
-- affected. Additive: replaces the function body only; no data changed.
CREATE OR REPLACE FUNCTION wealth_trg_external_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NULLIF(current_setting('wealth.actor', true), '') IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'wealth_accounts' THEN
    IF NEW.balance_status = 'pending_reconciliation'
       AND (TG_OP = 'INSERT' OR OLD.balance_status IS DISTINCT FROM NEW.balance_status) THEN
      RAISE EXCEPTION 'external writer: balance_status pending_reconciliation is not allowed (rules.md §2: use verified with bank evidence, or stale for an estimate)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.balance_as_of IS NOT NULL AND NEW.balance_as_of IS NOT NULL AND NEW.balance_as_of < OLD.balance_as_of
       AND NEW.balance_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION 'external writer: an estimated balance cannot move back in time (balance_as_of % -> %); record a newer balance, or a verified one with bank evidence', OLD.balance_as_of, NEW.balance_as_of
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'pending_reconciliation' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    RAISE EXCEPTION 'external writer: balance status pending_reconciliation is not allowed (rules.md §2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
