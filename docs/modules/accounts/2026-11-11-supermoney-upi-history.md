# 2026-11-11 — super.money UPI history: missing Slice Savings payments added; card duplicates found

- **Status:** (a) and (b) applied to Production with owner approval ("a,b"); (c) prepared and dry-run, **not run** (awaiting owner review)
- **Source:** `sm_receipt_1794380635759.pdf`, a super.money (Yes Bank UPI) transaction history, 28 Aug 2024 – 29 Sep 2026, about 165 payments from Slice Savings ••3731, Slice credit card ••36, Unity SFB credit card ••79, Bank of India ••4556 and HDFC ••9498

## Findings (read-only, Production)

- Transactions in the database start on 21 May 2026. In that range, the file's 6 Slice credit-card payments were already stored. **8 Slice Savings ••3731 Awfis payments (₹935) were missing.** Slice Savings had only 9 transactions, all from 3 Nov 2026.
- Rows before 21 May 2026 are only the payments made through super.money, not full statements.
- **Likely double counting:** the same Slice credit-card payment stored twice, once from the workbook import ("Awfis") and once from the Slice statement import ("Awfis · UPI · Slice statement"). One-to-one pairing finds **93 plain rows, ₹1,26,297.54** (an earlier count of 95 treated three 4-row groups as 3 copies each; each is 2 pairs). 7 more pairs (₹4,352) come from the same import and need owner review.

## Applied

| Step | Repair | Result |
|---|---|---|
| (a) | [`2026-11-11-supermoney-slice-savings-awfis.sql`](../../../scripts/db/repairs/2026-11-11-supermoney-slice-savings-awfis.sql) | 8 expenses on Slice Savings ••3731, category Awfis, description `Awfis · UPI · super.money (…)`: 3, 10, 12, 15, 16, 17, 24 Jun and 29 Sep 2026. Audited as `owner`. Re-run inserts 0 |
| (b) | same file | One `wealth_snapshots` record `supermoney-upi-history-2026-11-11` (Tools → Other records) describing the file and what was used. Older rows are not added to transactions, so monthly averages stay honest |

Backup first: `prod-before-supermoney.wlb` (32 tables, 2,288 rows). Transactions went from 596 to 604.

## Prepared, not run

- (c) [`2026-11-11-mark-slice-card-duplicates.sql`](../../../scripts/db/repairs/2026-11-11-mark-slice-card-duplicates.sql): marks each plain row `duplicate_of` its statement twin (the 1st plain row pairs with the 1st statement row of the same date, amount and merchant, and so on). It never deletes; it can be undone by clearing `duplicate_of`. **Applied 2026-11-11** (owner: "dublicate record in spending find and solve"): backup `prod-before-dupes.wlb` (32 tables, 4,335 rows), UPDATE 93 (₹1,26,297.54); a re-run marks 0. **Then deleted on owner request ("delete")**, an exception to the no-deletion rule: backup `prod-before-dupe-delete.wlb` (32 tables, 4,428 rows); only marked rows that no other table references; the script refused to run unless exactly 93 matched; DELETE 93; transactions now 1,523; deletes recorded in the audit log. The one-off script is not in `scripts/db/repairs`, so the repository guard against deleting data stays strict.

## Addition 2026-11-11 — Paytm UPI statement, 11 Nov 2023 – 10 Nov 2024

- 151 pages, 963 payments. Totals as printed: paid ₹10,70,611.47 (846), received ₹6,73,561.70 (117); self-transfers excluded.
- The whole period is before the ledger starts (21 May 2026), so nothing was matched or added to transactions.
- Owner approved ("paytm summary approved"): **one** reference record `paytm-upi-statement-2023-11-11..2024-11-10` (1.6 KB; per-account totals and notes; no name, phone or email) via [`2026-11-11-paytm-upi-summary-2023-24.sql`](../../../scripts/db/repairs/2026-11-11-paytm-upi-summary-2023-24.sql). Backup first: `prod-before-paytm-summary.wlb` (32 tables, 2,306 rows).
- Open questions, for the owner to raise when ready: crypto on CoinDCX ("Neblio Technologies", notes "DCX") and CoinSwitch ("Bitcipherlabsllp") is not recorded as a holding; the NDX P2P (likely LiquiLoans) ₹15,000 from 20 Nov 2023; the monthly ₹21,600 to HDFC A/c ••7649.

## Addition 2026-11-11 — Paytm 2023-24 payments imported into Activity (owner: "Add as normal transactions")

- Owner chose to add the Paytm payments as normal transactions, knowing 2023-24 months are partial (UPI payments only).
- Extraction: `pdfjs-dist@4.0.379` (scratch folder, not a project dependency) read the 151-page PDF by column position. The result was checked against the printed totals: **846 paid = ₹10,70,611.47, 117 received = ₹6,73,561.70, 53 self-transfers**, every row with a UPI/bank reference. Two rows Paytm printed twice with the same UPI reference (Vel Pharmacy ₹80 on 18 May 2024, Gayathri S ₹130 on 28 Mar 2024) were imported once.
- Classification follows the existing data: merchants → `expense` with the merchant as category; person-to-person → `transfer` (Transfer sent / received); own-account moves → `transfer` "Self transfer"; refunds and cashback → `income`; CoinDCX ("Neblio Technologies") / CoinSwitch ("Bitcipherlabsllp") / Angel One funds / Angel One MF / NDX P2P → `investment`; EarlySalary, IDFC, LazyPay, Paytm Postpaid / ABFL → `liability` "Loan repayment".
- Accounts: BOI ••56 → Bank of India Savings ••4556; HDFC ••98 → HDFC Bank Savings ••9498; Paytm Payments Bank and non-UPI → no linked account (text label).
- Description: `<payee> · UPI · Paytm[ · note] · ref <UPI ref>`. The import skips a row whose reference and amount already exist, so re-running adds nothing (tested on Development: 1,014, then 0).
- Production (backup `prod-before-paytm-import.wlb`, 32 tables, 2,307 rows): **1,014 rows**: expense 440 (₹1,55,701.99), income 21 (₹9,871.70), investment 129 (₹4,42,952: CoinDCX ₹3,59,251 in 102 payments, Angel One ₹58,801, P2P ₹15,000, CoinSwitch ₹9,500, Angel One MF ₹400), loan repayments 22 (₹38,834.48), transfers 402 (₹13,34,506.43). Transactions 604 → 1,618; audited as owner. The reference record's note was updated to say the rows are now in Activity.
- Effect: Activity "All time" and monthly spending statistics now include Nov 2023 – Nov 2024 (partial months). There is no data between Nov 2024 and May 2026.

## Duplicate check across all spending (2026-11-11)

Same date, same account, same amount, before the fix: 99 groups. After marking the 93 Slice card copies, 12 groups are left and kept on purpose:
- **Different payees, same small amount** (Bank of India 3, Slice 3): separate real payments.
- **Paytm, same payee, different UPI ref** (IRCTC ₹1,272.50 on 29 Nov 2023; Devasagayam Xavier ₹10 on 23 Jun 2024): separate payments; the ref numbers differ.
- **Slice statement entry 1 and entry 2** (Zarivault ₹950 on 1 Jun; Awfis ₹100 on 29 Jun): the statement itself lists two payments.
- **Workbook-only pairs** (Zarivault ₹950 on 25 May; Awfis ₹100 on 1 Jul): no statement row to compare; kept as two payments unless the owner says otherwise.

## HDFC Bank ••9498 statements (2026-11-11)

Owner request ("read use that", then "approve"): two password-protected HDFC statements, 1 Apr 2025 – 31 Mar 2026 (565 rows) and 1 Apr – 10 Nov 2026 (76 rows), added as normal transactions.
- Extracted with pdfjs; every row's running balance chains, and counts, debits, credits and closing balance match the printed STATEMENT SUMMARY (closing ₹3.89 = stored balance).
- 3 rows already stored from the other side were skipped: ₹94,000 salary (2 Nov), ₹627 card bill (6 Oct, on card ••9229), ₹80,000 (3 Nov).
- Labels: own UPI IDs and Paytm wallet payouts → Self transfer (80, ₹14,00,426); UPI to people ≥ ₹2,000 → Transfer sent; smaller UPI and merchants → spending; GrowHigh.ai / Neenam NEFT → Salary; ₹90,000 Performance bonus; Angel One → Funds added / payout; USD 51.67 remittance → US stocks.
- No name, PAN or phone number stored; descriptions end in "· HDFC statement · ref <bank ref>" (idempotency key).
- Development rehearsal: 638, re-run 0. Production: backup prod-before-hdfc-import.wlb (32 tables, 4,428 rows), **INSERT 638** (income 39 ₹11,00,377.86; transfer 135 ₹16,62,553.67; investment 48 ₹1,34,962.99; liability 5 ₹18,712.98; expense 411 ₹97,858.78); re-run 0; 638 audited as owner; transactions now 2,161.
- The 21 same-day, same-amount groups on this account are separate statement entries (each has its own bank ref and balance step), not duplicates.

## Self transfers out of money in and out (2026-11-11)

Owner request: self transfers must not count as money in or out. The app counts only income/expense (+ investment, liability); `transfer` rows are shown apart. Audit of every non-transfer row found 2 own-account credits stored as income (workbook import, 3 Nov 2026: ₹80,000 "Karthikeyan Subramanian", ₹800 "Karthikeyan S", both "Unconfirmed credit — verify"). Repair [`2026-11-11-self-transfers-not-income.sql`](../../../scripts/db/repairs/2026-11-11-self-transfers-not-income.sql): backup `prod-before-self-transfers.wlb` (32 tables, 5,704 rows), UPDATE 2 → kind `transfer`, category Self transfer; re-run 0. November money in drops by ₹80,800.

## Slice Savings dropped out of the bank total (2026-11-11)

An external writer (ChatGPT, audit actor `external`) added "UPI transfer to Arun S" ₹5,000 at 13:40 IST and set Slice Savings ••3731 to ₹42,889.22 with status `pending_reconciliation`. Totals count only `verified` and `stale` (estimated) balances, so the account left the bank total and net worth. Repair [`2026-11-11-slice-savings-status.sql`](../../../scripts/db/repairs/2026-11-11-slice-savings-status.sql) (owner: "now fix it"): backup `prod-before-slice-status.wlb` (32 tables, 5,771 rows); status → `stale` / `estimated`, amount unchanged; re-run 0.

**Rule for external writers:** when adding a transaction, write `wealth_transactions` only; never change `wealth_accounts` / `wealth_account_balances`, or use status `verified` (bank evidence) or `stale` (estimate) — never `pending_reconciliation`.
