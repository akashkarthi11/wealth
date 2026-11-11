-- 0010: the audit log stores only what changed (owner rule 2026-11-11: "store only required data").
-- Function change only; existing audit rows are kept as they are.
--   insert → after = the new row         delete → before = the old row
--   update → before / after = ONLY the columns whose value changed; an update that changes nothing but
--            updated_at is not recorded at all.
CREATE OR REPLACE FUNCTION wealth_trg_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_before jsonb; v_after jsonb; v_row jsonb; v_id text;
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, n.value) INTO v_before, v_after
      FROM jsonb_each(to_jsonb(OLD)) o JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
      WHERE o.value IS DISTINCT FROM n.value AND o.key <> 'updated_at';
      IF v_before IS NULL THEN RETURN NULL; END IF;          -- nothing meaningful changed
      v_row := to_jsonb(NEW);
    ELSIF TG_OP = 'INSERT' THEN
      v_after := to_jsonb(NEW); v_row := v_after;
    ELSE
      v_before := to_jsonb(OLD); v_row := v_before;
    END IF;
    v_id := coalesce(v_row->>'id', concat_ws('/', v_row->>'account_id', v_row->>'instrument_id', v_row->>'as_of'));
    INSERT INTO wealth_audit_log (actor, action, table_name, row_id, before, after)
    VALUES (coalesce(NULLIF(current_setting('wealth.actor', true), ''), 'external'), lower(TG_OP), TG_TABLE_NAME, v_id, v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wealth audit failed on %: %', TG_TABLE_NAME, SQLERRM;   -- auditing never blocks the write
  END;
  RETURN NULL;
END $fn$;
