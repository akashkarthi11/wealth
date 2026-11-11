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
