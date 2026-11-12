# Assistant Operating Rules — Wealth Project

This file contains the user's instructions to the AI assistant. Read and follow it before every Wealth database, ledger, portfolio, code, migration, or deployment task. These are operating instructions for the assistant, not merely application documentation.

## 1. Transaction recording — strict database boundary
- When adding a transaction, insert it into `wealth_transactions` only.
- Do not change `wealth_accounts` while recording a transaction.
- Do not insert, update, or delete rows in `wealth_account_balances` while recording a transaction.
- Do not automatically deduct transaction amounts from account balances or recalculate balances as a side effect.
- Check for an existing transaction/reference before inserting; do not create duplicates.
- Preserve the correct user, transaction kind, category, description, amount, account label/account_id when known, occurrence date, and external reference when available.
- Verify the inserted transaction by its external reference or ID and report the result.

## 2. Balance updates
- Do not update balances as part of transaction insertion.
- Only update a balance when the user explicitly requests it or a specific authorized workflow requires it.
- Use `verified` only when supported by a bank screenshot, bank statement, or equivalent direct bank evidence.
- Use `stale` for an estimate, including a calculated balance based on an earlier balance and later transactions.
- Never use `pending_reconciliation`.
- Never describe an estimate as verified. Preserve the evidence timestamp and explain the estimate where the schema supports a note.

## 2a. Interest — never record it from screenshots
- Screenshots (Slice, Atom, bank apps) show interest as a **full / running total** ("interest earned this month", "November savings interest", "₹X interest earned yesterday").
- **Do not save any interest from a screenshot into the database** — no income transaction, no interest row, no balance change for it.
- Interest is handled by the app's own nightly interest task (it calculates and records it every night). Saving it again from a screenshot double-counts it.
- If a screenshot shows only interest, there is nothing to record. If it also shows other transactions, record only those.
- **This applies to every task, not only screenshots.** Interest is written ONLY by the app's nightly job (Vercel cron
  `/api/nightly`, 01:30 IST). ChatGPT / agents must NOT insert or update: interest income transactions, "daily interest credit"
  rows, `wealth_interest_ledger` rows, or interest statements. The nightly job keeps exactly one "interest this month" income
  row per account (Slice Savings, Atom) and updates that same row every night; a new row starts each month.
- If an older scheduled prompt has an "interest accrual" or "interest credit" step, skip it — report only.
- The current scheduled-task prompts are in [`task.md`](task.md) (daily check). Use those, not older copies.

## 3. Production and Development database safety
- Treat Production as protected. Do not alter Production during a Development migration or test.
- When the user requests a Production-only operation, use the Production project only.
- When the user explicitly selects Development, use Development only.
- Never switch database projects/environments implicitly.
- For a Production-to-Development migration, preserve Production untouched; migrate the requested data to Development and verify records/data after migration.
- Do not claim a migration or database change succeeded until it has actually been executed and verified.
- Do not modify unrelated records or schema.

## 4. Branch and deployment rules
- Respect the branch the user explicitly names.
- The user has a `v2` branch; do not merge into, overwrite, or otherwise disturb `v2` when the user says to leave v2 alone.
- When asked to work on Development, use the Development branch and keep unrelated branches untouched.
- When asked to create a new Vercel URL for `v2`, configure the Vercel project/deployment for that branch; do not silently change the Production deployment.
- When asked to commit, make the requested commit and report the branch and commit SHA. Do not claim a commit was made if it was not.

## 5. Spending ledger rules
- For a spending entry, use the bank/account explicitly mentioned by the user.
- If the user does not mention a source bank, default to BOI.
- If BOI does not have sufficient available balance, ask the user which bank/account to use; do not choose another account yourself.
- Deduct spending from the selected source bank in the wealth ledger/accounting workflow as applicable, and include it in today's, this week's, this month's, and this year's spending totals.
- Keep transaction insertion subject to Section 1: adding the transaction itself writes only to `wealth_transactions`. Do not mutate account or balance tables as a side effect.

## 5a. Slice credit-card spending and Monies rewards
- A purchase charged to the Slice credit card is an expense against the card account, not an immediate cash deduction from Slice Savings or another bank account.
- Record each card purchase once against the Slice credit-card account in `wealth_transactions`; include it in spending totals and increase the estimated card liability under the existing card-liability calculation.
- A Slice credit-card purchase (including a card-funded investment purchase) earns Monies under the active Slice scheme. Count only eligible `expense` / `investment` transactions attached to a Slice account whose account type is `credit_card`; exclude Slice Savings spends, card-bill transfers/payments, refunds, cashback credits, duplicate rows and statement-summary/liability rows.
- The Slice Monies rate is tiered: 1% below 3,00,000 Monies, 1.5% from 3,00,000, and 2% from 5,00,000. Use the scheme and recorded balance as the source of truth; do not invent a reward credit.
- Show Monies earned from eligible card purchases after the latest recorded reward-balance timestamp as a clearly labelled **estimated** accrued amount added to the displayed effective Monies balance/value. Do not write estimated Monies into `wealth_reward_balances` or create reward events automatically. When a newer bank/app reward balance screenshot is recorded, its timestamp becomes the new baseline so the same card purchases are not counted twice.
- A card bill payment is a transfer that reduces the card liability and cash account balance as appropriate; it is not a second expense and does not earn Monies.
- Keep rewards/points value separate from net worth unless the user explicitly confirms it is withdrawable cash or a realizable asset.

## 6. Portfolio and stock-analysis rules
Whenever the user asks about their portfolio or stocks:
- Review overall portfolio diversification.
- Review MTF exposure and associated risk.
- Suggest ways to reduce borrowing/interest costs.
- Recommend only strong, high-quality growth stocks.
- Maintain balance across permitted sectors.
- Keep small-cap exposure within the user's defined limits; do not expand it casually.
- Apply BUY / HOLD / SELL logic consistently and explicitly.
- Keep explanations concise and avoid unnecessary long write-ups.
- Do not suggest F&O or non-Indian markets unless the user explicitly asks.

## 7. Assistant responsibility and verification
- Apply these rules yourself; do not treat them merely as application documentation.
- Before a Wealth operation, consult this file on the selected working branch when accessible.
- If the user has already specified a constraint, do not ask them to repeat it.
- If a requested action conflicts with these rules, or required evidence/access is missing, explain the exact blocker rather than guessing or claiming success.
- Report only actions actually completed and verified.
