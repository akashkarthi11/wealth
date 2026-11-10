-- Unified recurring obligations and payment occurrences.
-- Safe, additive migration: preserves legacy bills and mandates; does not delete or rewrite transactions.
BEGIN;

CREATE TABLE IF NOT EXISTS wealth_recurring_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  obligation_key text NOT NULL,
  title text NOT NULL,
  obligation_type text NOT NULL DEFAULT 'other',
  expected_amount numeric(18,2),
  amount_type text NOT NULL DEFAULT 'fixed',
  frequency text NOT NULL DEFAULT 'one_time',
  start_date date,
  next_due_date date,
  end_date date,
  account_id uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL,
  mandate_id uuid REFERENCES wealth_subscriptions(id) ON DELETE SET NULL,
  source_type text NOT NULL DEFAULT 'manual',
  source_record_id uuid,
  status text NOT NULL DEFAULT 'active',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_recurring_obligations_user_key_uq UNIQUE(user_id, obligation_key),
  CONSTRAINT wealth_recurring_obligations_type_ck CHECK (obligation_type IN ('rent','utility','insurance','subscription','savings','loan','investment','other')),
  CONSTRAINT wealth_recurring_obligations_amount_type_ck CHECK (amount_type IN ('fixed','variable','up_to')),
  CONSTRAINT wealth_recurring_obligations_amount_ck CHECK (expected_amount IS NULL OR expected_amount > 0),
  CONSTRAINT wealth_recurring_obligations_frequency_ck CHECK (frequency IN ('one_time','daily','weekly','monthly','quarterly','half_yearly','yearly','as_presented','frequency_not_confirmed')),
  CONSTRAINT wealth_recurring_obligations_status_ck CHECK (status IN ('active','paused','cancelled','completed')),
  CONSTRAINT wealth_recurring_obligations_source_ck CHECK (source_type IN ('planned_bill','subscription','manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS wealth_recurring_obligations_source_uq
  ON wealth_recurring_obligations(source_type, source_record_id)
  WHERE source_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wealth_recurring_obligations_user_due_idx
  ON wealth_recurring_obligations(user_id, status, next_due_date);

CREATE TABLE IF NOT EXISTS wealth_payment_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  obligation_id uuid NOT NULL REFERENCES wealth_recurring_obligations(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  expected_amount numeric(18,2) NOT NULL,
  actual_amount numeric(18,2),
  status text NOT NULL DEFAULT 'planned',
  transaction_id uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  source_record_id uuid,
  paid_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_payment_occurrences_due_uq UNIQUE(obligation_id, due_date),
  CONSTRAINT wealth_payment_occurrences_expected_ck CHECK (expected_amount > 0),
  CONSTRAINT wealth_payment_occurrences_actual_ck CHECK (actual_amount IS NULL OR actual_amount >= 0),
  CONSTRAINT wealth_payment_occurrences_status_ck CHECK (status IN ('planned','paid','skipped','cancelled'))
);
CREATE INDEX IF NOT EXISTS wealth_payment_occurrences_user_due_idx
  ON wealth_payment_occurrences(user_id, status, due_date);
CREATE INDEX IF NOT EXISTS wealth_payment_occurrences_obligation_due_idx
  ON wealth_payment_occurrences(obligation_id, due_date DESC);

ALTER TABLE wealth_subscriptions
  ADD COLUMN IF NOT EXISTS obligation_id uuid
  REFERENCES wealth_recurring_obligations(id) ON DELETE SET NULL;

-- Import planned bills as obligations without changing their source records.
INSERT INTO wealth_recurring_obligations
  (user_id, obligation_key, title, obligation_type, expected_amount, amount_type,
   frequency, start_date, next_due_date, account_id, source_type, source_record_id,
   status, notes, created_at, updated_at)
SELECT DISTINCT ON (b.user_id, COALESCE(NULLIF(b.bill_key,''), b.id::text))
       b.user_id,
       'bill:' || COALESCE(NULLIF(b.bill_key,''), b.id::text),
       b.title,
       CASE
         WHEN lower(b.category) LIKE '%rent%' THEN 'rent'
         WHEN lower(b.category) LIKE '%utilit%' OR lower(b.category) LIKE '%electric%' THEN 'utility'
         WHEN lower(b.category) LIKE '%insurance%' THEN 'insurance'
         WHEN lower(b.category) LIKE '%saving%' OR lower(b.category) LIKE '%deposit%' THEN 'savings'
         WHEN lower(b.category) LIKE '%loan%' OR lower(b.category) LIKE '%emi%' THEN 'loan'
         WHEN lower(b.category) LIKE '%investment%' THEN 'investment'
         ELSE 'other'
       END,
       b.amount,
       'fixed',
       CASE WHEN b.recurrence IN ('one_time','daily','weekly','monthly','quarterly','half_yearly','yearly') THEN b.recurrence ELSE 'one_time' END,
       b.due_date,
       CASE WHEN b.status='planned' THEN b.due_date ELSE NULL END,
       b.account_id,
       'planned_bill',
       NULL,
       CASE WHEN b.status='cancelled' THEN 'cancelled' WHEN b.status='paid' THEN 'completed' ELSE 'active' END,
       COALESCE(b.payee,'') || CASE WHEN b.reference_masked IS NOT NULL THEN ' · ' || b.reference_masked ELSE '' END,
       b.created_at,
       b.updated_at
FROM wealth_planned_bills b
WHERE true
ORDER BY b.user_id, COALESCE(NULLIF(b.bill_key,''), b.id::text), CASE WHEN b.status='planned' THEN 0 ELSE 1 END, b.due_date ASC
ON CONFLICT (user_id, obligation_key) DO NOTHING;

-- Attach existing mandates to their corresponding planned-bill obligation where the keys match.
UPDATE wealth_recurring_obligations o
SET mandate_id=s.id, updated_at=now()
FROM wealth_subscriptions s
JOIN wealth_planned_bills b
  ON b.user_id=s.user_id
 AND (
   b.bill_key=s.provider_key
   OR left(b.bill_key,length(s.provider_key)+1)=s.provider_key || '_'
 )
WHERE o.user_id=b.user_id
  AND o.source_type='planned_bill'
  AND o.obligation_key='bill:' || COALESCE(NULLIF(b.bill_key,''),b.id::text)
  AND o.mandate_id IS NULL;

-- Preserve mandates that have no matching planned bill as their own recurring obligation.
INSERT INTO wealth_recurring_obligations
  (user_id, obligation_key, title, obligation_type, expected_amount, amount_type,
   frequency, next_due_date, account_id, mandate_id, source_type, source_record_id,
   status, notes, created_at, updated_at)
SELECT s.user_id,
       'mandate:' || s.provider_key || ':' || s.mandate_key,
       s.provider_name,
       CASE
         WHEN lower(s.provider_name) LIKE '%insurance%' OR lower(s.provider_name) LIKE '%lic%' THEN 'insurance'
         WHEN lower(s.provider_name) LIKE '%deposit%' OR lower(s.provider_name) LIKE '%fd%' THEN 'savings'
         WHEN lower(s.provider_name) LIKE '%loan%' OR lower(s.provider_name) LIKE '%emi%' THEN 'loan'
         ELSE 'subscription'
       END,
       NULLIF(s.amount,0),
       CASE WHEN s.amount_type IN ('fixed','variable','up_to') THEN s.amount_type ELSE 'fixed' END,
       CASE WHEN s.frequency IN ('one_time','daily','weekly','monthly','quarterly','half_yearly','yearly','as_presented','frequency_not_confirmed') THEN s.frequency ELSE 'frequency_not_confirmed' END,
       s.next_due_date,
       s.source_account_id,
       s.id,
       'subscription',
       s.id,
       CASE WHEN s.status='active' THEN 'active' WHEN s.status='paused' THEN 'paused' ELSE 'cancelled' END,
       COALESCE(s.merchant_id,''),
       s.created_at,
       s.updated_at
FROM wealth_subscriptions s
WHERE NOT EXISTS (
  SELECT 1 FROM wealth_planned_bills b
  WHERE b.user_id=s.user_id
    AND (b.bill_key=s.provider_key OR left(b.bill_key,length(s.provider_key)+1)=s.provider_key || '_'
)
ON CONFLICT (user_id, obligation_key) DO NOTHING;

-- Link subscription rows to the corresponding new obligation.
UPDATE wealth_subscriptions s
SET obligation_id=o.id
FROM wealth_recurring_obligations o
WHERE o.user_id=s.user_id
  AND o.mandate_id=s.id
  AND s.obligation_id IS NULL;

-- Backfill one occurrence per existing planned-bill due date. Future cycles are generated by the app.
INSERT INTO wealth_payment_occurrences
  (user_id, obligation_id, due_date, expected_amount, actual_amount, status,
   source_record_id, paid_at, created_at, updated_at)
SELECT b.user_id, o.id, b.due_date, b.amount,
       CASE WHEN b.status='paid' THEN b.amount ELSE NULL END,
       CASE WHEN b.status='paid' THEN 'paid' WHEN b.status='cancelled' THEN 'cancelled' ELSE 'planned' END,
       b.id,
       CASE WHEN b.status='paid' THEN b.updated_at ELSE NULL END,
       b.created_at, b.updated_at
FROM wealth_planned_bills b
JOIN wealth_recurring_obligations o
  ON o.user_id=b.user_id
 AND o.source_type='planned_bill'
 AND o.obligation_key='bill:' || COALESCE(NULLIF(b.bill_key,''),b.id::text)
WHERE true
ON CONFLICT (obligation_id, due_date) DO NOTHING;

-- Backfill the next known due date for mandate-only recurring obligations.
INSERT INTO wealth_payment_occurrences
  (user_id, obligation_id, due_date, expected_amount, status, created_at, updated_at)
SELECT o.user_id, o.id, s.next_due_date, s.amount, 'planned', s.created_at, s.updated_at
FROM wealth_subscriptions s
JOIN wealth_recurring_obligations o ON o.id=s.obligation_id AND o.user_id=s.user_id
WHERE s.next_due_date IS NOT NULL
  AND s.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM wealth_payment_occurrences p
    WHERE p.obligation_id=o.id AND p.due_date=s.next_due_date
  )
ON CONFLICT (obligation_id, due_date) DO NOTHING;

COMMIT;
