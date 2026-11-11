# 2026-11-11 — Angel One ledger statement kept as history (migration 0011)

- **Status:** code + tests on `claude-dev`; migration 0011 applied to Development and the statement imported there; Production after a backup and owner approval
- **Owner request:** "for history and can we use this data anywhere" → yes

## What the statement is

Angel One "Ledger Statement" export (`.xlsx`) with three sheets, 5 Nov 2021 – 11 Nov 2026:

| Sheet | Entries | Content |
|---|---|---|
| Broking Ledger | 801 | Funds added and withdrawn, trades executed, charges, MTF transfers; closing −₹3.81 |
| MTF Ledger | 151 | Margin-trading buys, closures and transfers; closing ₹0, last entry 5 Dec 2025 |
| Charges | — | A day-wise breakdown of charges that are already in the broking ledger (not imported, to avoid double counting) |

It has **no holdings, units or FD terms**. Fixing the Nippon units, stock quantities and FD terms needs the Holdings / DP statement.

## Design

- New table `wealth_broker_ledger` (migration `0011_broker_ledger.sql`): one row per ledger entry as printed (date, type, segment, voucher, debit, credit, running balance) plus a `kind` (`funds_added`, `funds_withdrawn`, `trade`, `charge`, `mtf_transfer`, `credit_other`).
- Unique per user + broker + ledger + voucher + type + date + amounts, so re-importing a newer statement adds only new entries.
- **Not** in `wealth_transactions`: trades and charges are not spending, and funds added would double-count the bank transfer. A funds-added entry links to the bank transaction instead (`matched_transaction_id`).
- "Quarterly Settlement" (unused funds the broker returns to the bank) counts as withdrawn.
- The parser refuses a sheet whose entries do not add up to the printed Total Credit, Total Debit and Closing Balance.

## Code

| File | Role |
|---|---|
| `api/_broker.js` | `ledgerKind`, `parseLedgerSheet`, `importBrokerLedger`, `matchBrokerFunds`, `brokerSummary` |
| `scripts/db/xlsx-lib.mjs` | Dependency-free `.xlsx` reader (zip + XML) |
| `scripts/db/import-broker-ledger.mjs` | `node scripts/db/import-broker-ledger.mjs <env-file> <statement.xlsx> [--apply --yes]`; check-only by default |
| `api/_routes/dashboard.js` | Adds `broker` (summary per broker) to the dashboard response; an empty list if the table is missing |
| `app.js` `brokerPanelHtml` | Investments → Indian stocks: net put in, value now (stocks + broker cash), overall gain, broker charges (lifetime and this year), by-year table, MTF status, matched transfers |

## Matching bank transfers

Each unmatched funds-added entry links to an `investment`/`transfer` transaction whose description or category names Angel One, with the same amount, within 3 days (closest date first). If that transaction's category still says "pending" or "verify", it becomes **"Funds added to Angel One"**. Owner-set categories are left alone. Changes go through `withActor('owner')`, so the audit log records only the category change.

## Verification

- `scripts/tests/broker.test.mjs` (4 tests): kind rules; totals check; idempotent import; matching (wrong name never matched, owner category kept, second run matches nothing, audit row has only `category`); summary numbers; empty summary without data.
- `scripts/tests/investments.test.mjs` (+2): panel numbers and no panel without a ledger.
- Development (2026-11-11): 952 entries imported, a re-run added 0; 3 transfers matched (₹7,100 and ₹2,000 on 3 Nov recategorised, ₹4,782 on 6 Nov kept); added ₹3,69,093, withdrawn ₹1,56,860.02 (incl. ₹3,906.99 quarterly settlements), **net put in ₹2,12,232.98**, charges ₹4,442.10 (₹991.20 in 2026), cash −₹3.81, MTF ₹0 since 5 Dec 2025.

## Limits

- Overall gain compares stocks and ETFs only. Mutual funds bought through Angel One are paid from the bank and do not appear in this ledger. Dividends paid to the bank are not included.
- The panel is only as current as the last uploaded statement (its date is shown).
