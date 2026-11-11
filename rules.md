# Assistant Operating Rules — Wealth Project

This file is an instruction document for the AI assistant working on this Wealth project. Read and follow it before performing any Wealth database, ledger, balance, or related code operation. These rules take precedence over convenience or assumptions.

## 1. Recording transactions
- Insert a new transaction into `wealth_transactions` only.
- Do not modify `wealth_accounts` when recording a transaction.
- Do not insert, update, or delete rows in `wealth_account_balances` when recording a transaction.
- Do not automatically deduct a transaction amount from an account balance or recalculate account balances as a side effect.
- Check for an existing transaction/reference before inserting so the same transaction is not recorded twice.
- Preserve the correct user, transaction kind, category, description, amount, account label/account_id when known, occurrence date, and external reference when available.

## 2. Balance updates
- Update balances only when the user explicitly requests a balance update or a workflow specifically requires one.
- Use `verified` only when supported by a bank screenshot, bank statement, or equivalent direct bank evidence.
- Use `stale` for an estimated balance (including calculations based on an earlier balance and later transactions).
- Never use `pending_reconciliation`.
- Never present an estimated balance as verified. Preserve the evidence timestamp and explain the estimate where the schema supports a note.

## 3. Environment safety
- Treat the Production database as protected. Never switch environments or write to a different project/branch implicitly.
- Follow the user's explicitly selected target environment and branch for code changes.
- Do not modify unrelated data or create duplicate ledger entries.

## 4. Verification
- After inserting a transaction, verify the row in `wealth_transactions` using its external reference or inserted ID.
- Confirm that `wealth_accounts` and `wealth_account_balances` were not changed by the transaction-insertion operation.
- Report what was actually verified; do not claim a balance update unless it was explicitly requested and completed.

## 5. Assistant responsibility
- Apply these rules yourself; do not treat them merely as application documentation.
- Before any future Wealth operation, consult this file on the selected working branch.
- If a requested action conflicts with these rules or the available evidence, stop and explain the conflict rather than silently guessing.
