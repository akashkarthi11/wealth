# 2026-11-11 — super.money UPI history: missing Slice Savings payments added; card duplicates found

- **Status:** (a) and (b) applied to Production with owner approval ("a,b"); (c) prepared and dry-run, **not run** (awaiting owner review)
- **Source:** `sm_receipt_1794380635759.pdf`, a super.money (Yes Bank UPI) transaction history, 28 Aug 2024 – 29 Sep 2026, about 165 payments from Slice Savings ••3731, Slice credit card ••36, Unity SFB credit card ••79, Bank of India ••4556 and HDFC ••9498

## Findings (read-only, Production)

- Transactions in the database start on 21 May 2026. In that range, the file's 6 Slice credit-card payments were already stored. **8 Slice Savings ••3731 Awfis payments (₹935) were missing.** Slice Savings had only 9 transactions, all from 3 Nov 2026.
- Rows before 21 May 2026 are only the payments made through super.money, not full statements.
- **Likely double counting:** the same Slice credit-card payment stored twice, once from the workbook import ("Awfis") and once from the Slice statement import ("Awfis · UPI · Slice statement"). One-to-one pairing finds **95 plain rows, ₹1,34,692.54**. 7 more pairs (₹4,352) come from the same import and need owner review.

## Applied

| Step | Repair | Result |
|---|---|---|
| (a) | [`2026-11-11-supermoney-slice-savings-awfis.sql`](../../../scripts/db/repairs/2026-11-11-supermoney-slice-savings-awfis.sql) | 8 expenses on Slice Savings ••3731, category Awfis, description `Awfis · UPI · super.money (…)`: 3, 10, 12, 15, 16, 17, 24 Jun and 29 Sep 2026. Audited as `owner`. Re-run inserts 0 |
| (b) | same file | One `wealth_snapshots` record `supermoney-upi-history-2026-11-11` (Tools → Other records) describing the file and what was used. Older rows are not added to transactions, so monthly averages stay honest |

Backup first: `prod-before-supermoney.wlb` (32 tables, 2,288 rows). Transactions went from 596 to 604.

## Prepared, not run

- (c) [`2026-11-11-mark-slice-card-duplicates.sql`](../../../scripts/db/repairs/2026-11-11-mark-slice-card-duplicates.sql): marks each plain row `duplicate_of` its statement twin (the 1st plain row pairs with the 1st statement row of the same date, amount and merchant, and so on). It never deletes; it can be undone by clearing `duplicate_of`. Dry run on Production: 95 rows, ₹1,34,692.54. Run only after owner approval.

## Addition 2026-11-11 — Paytm UPI statement, 11 Nov 2023 – 10 Nov 2024

- 151 pages, 963 payments. Totals as printed: paid ₹10,70,611.47 (846), received ₹6,73,561.70 (117); self-transfers excluded.
- The whole period is before the ledger starts (21 May 2026), so nothing was matched or added to transactions.
- Owner approved ("paytm summary approved"): **one** reference record `paytm-upi-statement-2023-11-11..2024-11-10` (1.6 KB; per-account totals and notes; no name, phone or email) via [`2026-11-11-paytm-upi-summary-2023-24.sql`](../../../scripts/db/repairs/2026-11-11-paytm-upi-summary-2023-24.sql). Backup first: `prod-before-paytm-summary.wlb` (32 tables, 2,306 rows).
- Open questions, for the owner to raise when ready: crypto on CoinDCX ("Neblio Technologies", notes "DCX") and CoinSwitch ("Bitcipherlabsllp") is not recorded as a holding; the NDX P2P (likely LiquiLoans) ₹15,000 from 20 Nov 2023; the monthly ₹21,600 to HDFC A/c ••7649.
