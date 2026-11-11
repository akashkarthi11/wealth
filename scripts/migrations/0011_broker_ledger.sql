-- 0011: broker funds ledger (owner request 2026-11-11: keep the Angel One statement as history and use it).
-- One row per ledger entry as printed by the broker. Re-importing a newer statement adds only new entries.
-- Not stored in wealth_transactions on purpose: trades and broker charges are not spending, and "funds added"
-- would double-count the bank-side transfer. A funds-added entry can point at that bank transaction instead.
CREATE TABLE IF NOT EXISTS wealth_broker_ledger (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  account_id             uuid REFERENCES wealth_accounts(id) ON DELETE SET NULL,
  broker                 text NOT NULL,                                     -- 'angel_one'
  ledger                 text NOT NULL CHECK (ledger IN ('broking','mtf')),
  entry_date             date NOT NULL,
  entry_type             text NOT NULL,                                     -- as printed, e.g. 'Funds Added'
  kind                   text NOT NULL CHECK (kind IN ('funds_added','funds_withdrawn','trade','charge','mtf_transfer','credit_other')),
  segment                text,
  voucher                text NOT NULL,
  debit                  numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit                 numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  running_balance        numeric(18,2),
  matched_transaction_id uuid REFERENCES wealth_transactions(id) ON DELETE SET NULL,
  source                 text NOT NULL,                                     -- statement label, e.g. 'Angel One ledger 2021-11-05..2026-11-11'
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_broker_ledger_entry_key UNIQUE (user_id, broker, ledger, voucher, entry_type, entry_date, debit, credit)
);
CREATE INDEX IF NOT EXISTS wealth_broker_ledger_user_date ON wealth_broker_ledger (user_id, broker, ledger, entry_date);
CREATE INDEX IF NOT EXISTS wealth_broker_ledger_matched ON wealth_broker_ledger (matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
