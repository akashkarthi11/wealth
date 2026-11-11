-- 0022: write off or remove single lending records (owner 2026-11-11: "write off per record", "after all settle it need
-- to list in history with 0", "we can delete if i mistake touch that us lend").
--   status on wealth_person_entries   active · written_off (kept, shown, not counted) · removed (a mistaken link: hidden,
--                                      not counted, the transaction can be linked again). The transaction itself is
--                                      never touched.
--   status on wealth_bill_split_shares active · written_off (that person's share is forgiven).
--   wealth_people.status              + removed (a person added by mistake with nothing left on them).
-- Additive: rows are never deleted; one-link-per-transaction and one-payment-per-share now ignore removed entries.
ALTER TABLE wealth_person_entries ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE wealth_person_entries ADD COLUMN IF NOT EXISTS status_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_person_entries_status_check') THEN
    ALTER TABLE wealth_person_entries ADD CONSTRAINT wealth_person_entries_status_check CHECK (status IN ('active', 'written_off', 'removed'));
  END IF;
END $$;

ALTER TABLE wealth_bill_split_shares ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE wealth_bill_split_shares ADD COLUMN IF NOT EXISTS status_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_bill_split_shares_status_check') THEN
    ALTER TABLE wealth_bill_split_shares ADD CONSTRAINT wealth_bill_split_shares_status_check CHECK (status IN ('active', 'written_off'));
  END IF;
END $$;

ALTER TABLE wealth_people DROP CONSTRAINT IF EXISTS wealth_people_status_check;
ALTER TABLE wealth_people ADD CONSTRAINT wealth_people_status_check CHECK (status IN ('open', 'settled', 'written_off', 'removed'));

-- A removed (mistaken) link frees the transaction / share for a correct link.
DROP INDEX IF EXISTS wealth_person_entries_tx_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_person_entries_tx_live_uniq ON wealth_person_entries (transaction_id) WHERE transaction_id IS NOT NULL AND status <> 'removed';
DROP INDEX IF EXISTS wealth_person_entries_share_paid_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS wealth_person_entries_share_paid_live_uniq ON wealth_person_entries (person_id, split_id) WHERE split_id IS NOT NULL AND status <> 'removed';
