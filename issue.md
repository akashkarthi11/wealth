# Wealth Ledger Issue Log

## Issue: November round-ups were double-counted on 11 Nov 2026

### What happened
- The Slice Activity screen showed **“Nov Round ups — ₹159”**, which is the **cumulative November total**, not a new transaction on 11 Nov.
- The detailed round-ups screen breaks that ₹159 into individual entries:
  - 11 Nov: ₹18
  - 7 Nov: ₹15
  - 6 Nov: ₹16 + ₹40 + ₹30 + ₹40
- Earlier ledger entries already included ₹141 of round-ups (the prior entries total ₹141).
- Only **₹18** was new on 11 Nov. Recording ₹159 as a fresh transaction incorrectly overstated round-ups by ₹141.

### Corrections applied
- Updated the 11 Nov “November round-ups” ledger row from **₹159 to ₹18**.
- Assigned that ₹18 transaction to **Slice Atom** (user's account naming). Do not silently map it to generic Atom Savings or another Slice account; preserve the exact product/account identity as confirmed by the user.
- Assigned **Gullak Technologies ₹1** to **Slice Savings ••3731**, based on the payment details screenshot.
- Confirmed **MMTC PAMP ₹21** was paid from **Slice Credit Card ••6136** and classified as an investment.
- Atom interest **₹76.36** remains assigned to Atom Savings.
- The generic savings interest **₹71.57** and Mr Arun S **₹5,000** are assigned to Slice Savings ••3731 based on the user's clarification that these transactions were from the savings side and the payment screenshot showing Slice Savings for the round-up/Gullak transactions.

### Rules for future imports (ChatGPT and Claude)
1. **Never treat a cumulative/month-to-date total as a new transaction.** A summary such as “Nov Round ups ₹159” is a running total unless the transaction detail proves it is a single posting.
2. Open or inspect the transaction breakdown and import only individual new postings not already present in the ledger.
3. Reconcile against existing ledger rows by date, description, amount, account, and transaction/reference ID before inserting. Do not duplicate existing entries.
4. For the November round-ups shown here, the month-to-date total is ₹159 and the new 11 Nov posting is only ₹18; the earlier ₹141 was already recorded.
5. Use payment-detail screenshots to identify the source account:
   - MMTC PAMP ₹21 → Slice CC ••6136.
   - Round-up ₹18 on 11 Nov → **Slice Atom** (user-confirmed account label; retain this exact identity).
   - Gullak Technologies ₹1 → Slice Savings ••3731.
   - Atom interest ₹76.36 → Atom Savings.
6. Do not guess an account for transactions where the source account is not visible. Leave it unassigned and ask for clarification if assigning it is necessary.
7. Keep transfers/savings round-ups distinct from consumption expenses. Do not count a savings transfer as spending.
8. **Account-name clarification:** The user explicitly clarified that “Round-ups (11 Nov)” is **Slice Atom**. This supersedes the earlier assumption that it was Slice Savings ••3731. For future imports and corrections, use the exact label “Slice Atom”; if the database does not yet have a matching account, ask before mapping it to another account.

### Verification note
The production database was updated and verified on 11 Nov 2026. The earlier development-only corrections were not assumed to have synced automatically. This issue file is maintained in the repository's development branch for future import workflows.

---

## Issue: November interest recorded as running totals AND as daily rows (found by Claude, fixed 11 Nov 2026)

### What happened
- Interest screens show **month-to-date** totals. The 11 Nov rows "November savings interest ₹71.57" and "November Atom interest ₹76.36" are running totals through 10 Nov (Slice: ₹57.15 MTD on 9 Nov + ₹7.21 + ₹7.21; Atom: ₹57.24 + ₹9.56 × 2).
- Earlier rows already inside those totals were still counted: Slice ₹35.53 (6 Nov), ₹42.74 (7 Nov), ₹7.20 (8 Nov), ₹7.21 (10 Nov); Atom ₹9.55 (8 Nov), ₹9.56 (10 Nov). November income was overstated by **₹111.79**.
- The "Slice Atom" clarification above (17:13) was committed after the database write (17:10), so the ₹18 round-up was still on Slice Savings ••3731.

### Corrections applied (Production, owner approval "yes, approve interest fix"; backup taken)
- The six rows are marked `duplicate_of` the ₹71.57 / ₹76.36 rows (nothing deleted; they drop out of totals). Script: `scripts/db/repairs/2026-11-11-november-interest-and-roundups.sql`.
- **Slice Atom = Atom Savings** (database account: bank "Atom", "Atom Savings" — owner confirmed). Round-ups ₹141 (7 Nov) and ₹18 (11 Nov) moved to Atom Savings.

### Rules for future imports (ChatGPT and Claude)
9. **Interest from screenshots is never saved** (owner rule, 11 Nov 2026; see rules.md §2a). Screens show interest as a full / running total; the app's nightly interest task records interest. Do not insert any interest transaction or row from a screenshot.
10. **Slice Atom = the "Atom Savings" account** (bank "Atom"). Round-ups and Atom interest go there.
11. Atom has **splits** (pots such as Rent). Until split tracking is added to the app, put Atom money on Atom Savings and name the split in the description; do not invent a split.

---

## Issue: New user onboarding — a non-owner user sees blank or empty pages (found 11 Nov 2026, to solve 12 Nov 2026)

### What happened
- A demo user **test@gmail.com** (password `1234567890`, role `user`) was created on Production to try the app as a new user.
- After signing in, the owner saw a **blank page**. The app is built for one owner (the admin); a second, normal user cannot set up
  most of their own data, and several pages are empty or show only "Owner only".
- To make the demo usable, sample data was written **directly with SQL** (no code changed). See "Demo data" below.

### Problems to solve
| # | Problem | Where | Effect for a new user |
|---|---|---|---|
| 1 | Account, balance and holdings routes are owner-only | `authorize()` in `api/_lib.js` (returns "Owner only" unless role is admin) | A new user cannot add bank accounts, balances or investments from the app at all |
| 2 | Rewards, Lending, Data quality, Interest sources, Snapshot, Angel One are owner-only, but their pages are still in the menu | `api/_routes/*` + `views` list in `app.js` | Pages show just "Owner only" |
| 3 | The last opened page is restored at sign-in (sessionStorage, per tab) | `readViewState()` / `showApp()` in `app.js` | Switching from admin to a new user in the same tab can open an owner-only page → looks blank |
| 4 | Subscriptions page returns an empty string when there are no subscriptions | `subscriptionsHtml()` in `app.js` (`return ''`) | Completely blank page (for any user with no subscriptions) |
| 5 | Bank Balances page reads the old `wealth_accounts.current_balance` and only counts `verified` / `stale`; the dashboard reads the account-model balance history | `liveBankAccounts()` / `bankCounted()` in `app.js` | Net worth shows a balance but Bank Balances says "No bank balance records found" |
| 6 | No way for a normal user to add subscriptions / mandates in the app | `api/_routes/planned-bills.js` (GET and PATCH only) | Subscriptions and Alerts stay empty |
| 7 | Owner-specific content is hard-coded | `app.js` / `index.html`: title "Karthi Portfolio"; interest card lists Slice Savings and Atom | Every user sees the owner's name and bank names |
| 8 | "A new Wealth Ledger version is available" prompt appears on a first visit | `promptForUpdatedApp()` in `app.js` (default previous build id) | Confusing first screen; cancelling can leave an old cached app |
| 9 | Only one admin is safe: agents (ChatGPT), cron and the nightly job write to "the admin user" (`ownerId()`) | `api/_lib.js`, `api/_routes/nightly.js` | Making a new user an admin to unlock pages would mix their data with the owner's jobs — do not do this |
| 10 | Sign-up needs the secret access key; password minimum is 10 characters | `api/_routes/auth.js`, `PASSWORD_MIN` in `api/_lib.js` | Fine for security, but onboarding instructions must say so |

### Decide tomorrow
- Should the app support **several independent users** (each user owns their own accounts, balances, holdings, rewards, loans), or stay
  **single-owner** with other users limited to a smaller view? This choice drives fixes 1, 2, 6 and 9.
- Quick fixes that do not depend on that choice: 3 (only restore pages the user may open), 4 (show "No subscriptions or mandates yet"),
  5 (Bank Balances should use the same balance as the dashboard), 7 (remove owner name / owner banks for other users), 8 (no prompt on first visit),
  and hide owner-only menu items for non-admin users.
- Code goes to `claude-dev` first, then `main` (only `main` deploys). Leave `v2` untouched.

### Demo data (Production, user test@gmail.com only — for cleanup later)
- 57 transactions: `external_ref LIKE 'demo-seed:%'`, linked to the two demo accounts.
- 2 accounts: Demo Bank "Demo Savings" XX1234 and Sample Bank "Salary Account" XX5678 (savings).
- Balances: ₹48,250.75 and ₹1,26,430.20 at 11 Nov 2026 19:45 IST, history status `reported`, account columns `stale`,
  note "Sample data for demo account". Never `verified`, never `pending_reconciliation`.
- 3 subscriptions: provider keys `demo-streaming-plus`, `demo-music-unlimited`, `demo-cloud-storage`.
- All writes used `wealth.actor = 'agent'`. Removing the user (`wealth_users` row) cascades to most of these rows — check before deleting.


---

## Issue: Expense transaction does not automatically reconcile the displayed account balance (reported 12 Nov 2026)

### What happened
- A ₹150 UPI expense to Yogeswaran V was inserted into Production `wealth_transactions` for Slice Savings ••3731, category `Travel`, on 12 Nov 2026.
- The transaction insert correctly followed `rules.md` §1 and changed only `wealth_transactions`; it did not mutate the account balance.
- The user expected the Slice Savings balance to reduce when the expense was added, but the displayed balance remained unchanged until a separate balance update was requested.

### Immediate correction applied (Production)
- Previous recorded balance: ₹42,877.46 (status `stale`, last recorded 11 Nov 2026).
- Expense: ₹150.00.
- Updated `wealth_accounts.current_balance` to **₹42,727.46** and retained status `stale`; this is an estimate, not a bank-verified balance.
- The transaction row remains recorded once; no duplicate was inserted.

### Follow-up
- Review the transaction-entry / spending-ledger workflow and make the balance impact explicit to the user.
- Preserve the strict database boundary in `rules.md`: transaction insertion itself must write only `wealth_transactions`. Any balance reconciliation must be a separate, explicitly authorized workflow, must retain `stale` status for estimates, and must not imply bank verification.
- Ensure the UI refreshes the displayed account balance after an authorized balance reconciliation.

---

## Issue: November rent counted twice — ₹16,342 instead of ₹8,142 (found by Claude, fixed 15 Nov 2026)

### What happened
- Overview → "This month: category spending" showed **Rent ₹16,342.00**, exactly 2 × ₹8,171.
- Production had two November `Rent` expenses (read-only check, owner user):

| Date | Amount | Source | Account | Reference |
|---|---|---|---|---|
| 3 Nov | ₹8,200 | Workbook import ("Unspecified — source workbook does not identify funding account") | none | none |
| 14 Nov | ₹8,142 | "Rent paid to Janesh (UPI)", accepted by the owner | Slice Savings | `PTMb3c4811bc…` |

- A third row, 14 Nov ₹8,142 "Self transfer: Atom Rent to Slice Savings" (pending, from Gmail), is a transfer and is not counted as spending.
- The 3 Nov workbook row was the planned rent for November; the 14 Nov row is the actual payment. Both were counted.
- These are the only `Rent` expenses in the whole history, so the "historical monthly average" also looked wrong (see the second issue below).

### Correction applied (Production, owner instruction "remove old", 15 Nov 2026)
- The 3 Nov ₹8,200 workbook row is marked `duplicate_of` the 14 Nov ₹8,142 payment (`duplicate_marked_at` set, `wealth.actor = 'owner'`).
  Nothing deleted; it drops out of every total. Guarded update: exactly one row matched (date, amount, no account, no reference).
- Result: November Rent **₹8,142** (1 entry). Overview November spending ₹32,258.20 afterwards.
- The app's own "mark duplicate" (`markDuplicate`, `/api/transaction-review`) refuses this pair because the amounts differ (₹8,200 vs ₹8,142),
  and there is no button for it in the app; the update was made directly with the same columns it writes.

### Rules for future imports (ChatGPT and Claude)
12. **A planned or budgeted amount from the workbook is not a payment.** When the real payment for the same month arrives (bank / UPI / screenshot),
    the planned row must not stay counted. Check the month for an existing row of the same category before inserting, and mark the planned one
    `duplicate_of` the real one.
13. Rent is paid from the **Atom "Rent" split** → self transfer to Slice Savings → UPI to Janesh. Only the UPI payment is the expense; the transfer is not spending.

### Follow-up
- Add an in-app way to mark a duplicate when the amounts differ slightly (planned vs actual), or a "planned" status that is replaced by the actual payment.
- The Overview still showed "Monthly rent + current bill (estimated ₹8,000–₹8,500)" as due within 5 days after the 14 Nov payment: payment alerts do not look
  at transactions already paid this month. To check.

---

## Issue: "Historical monthly average" per category was this month ÷ all months (found and fixed 15 Nov 2026)

### What happened
- "This month: category spending" showed, under each category, "historical monthly average ₹X". The code computed **this month's category amount ÷
  every month with spending** (`value/allMonths`), not the average of earlier months. Rent: ₹8,142 ÷ 37 = ₹220.05.

### Fix (code, deployed to Production 15 Nov 2026, `main` f827bbf)
- Each category row now shows **"Daily avg this month"** and **"earlier months ₹X a month (₹Y a day)"**, from the months before the current one
  (`pastCategoryAverages()` in `app.js`), or **"not in earlier months"** when the category is new.

---

## Issue: accepting a credit-card spend made the amount owed go DOWN (found by simulating a ChatGPT insert, fixed 15 Nov 2026)

### How it was found
- Simulated (local copy) exactly what ChatGPT does: a plain `INSERT INTO wealth_transactions` with `wealth.actor = 'agent'`, no review status
  → the row is `pending` (0029 default). One ₹450 savings expense (HDFC Savings) and one ₹1,200 spend on the Slice Credit Card.

### What happened
- **Savings:** balance unchanged until Accept (by design, rules.md §1/§2). Accept: ₹1,28,400.10 → ₹1,27,950.10. Correct.
- **Credit card:** the owed amount shown = last balance + card spends after it, pending ones included, so it rose at once (₹11,480). Then
  **Accept** wrote "last balance + this one spend" (₹6,480 + ₹1,200 = ₹7,680) stamped *now*, and the card estimate counted only spends after
  that newest balance — every other un-accepted spend vanished. Owed dropped ₹11,480 → ₹7,680 after accepting a spend.
- The Accept preview also started from the recorded balance (₹6,480 → ₹7,680), not from the owed amount shown (₹11,480).

### Fix (code)
- `cardMovesSinceBalance()` (`api/_queries.js`): card activity is counted after the last **recorded** balance (statement / screenshot / owner —
  not one written by Accept), and leaves out movements already applied into a balance (`applied_balance_as_of` set: accepted payments,
  posted cashback). Accepting or dismissing one spend never hides another; a new recorded balance starts the count again.
- `pendingTransactions()` (`api/_accept.js`): a card's preview starts from the owed amount shown, without this payment
  (e.g. ₹10,280 → ₹11,480).
- Test: `scripts/tests/card-liability.test.mjs` "card: spends added like ChatGPT (pending) …" (fails on the old code: ₹31,757.95 instead of ₹35,557.95).

### For ChatGPT
14. Keep inserting transactions only (rules.md §1). A card spend counts in the amount owed at once; a savings payment changes the balance when
    the owner presses Accept. Do not write balances to "fix" either.
