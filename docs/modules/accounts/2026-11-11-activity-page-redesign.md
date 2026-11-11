# 2026-11-11 — Activity (Transactions) page: no totals, raw dates, risky delete, filters reset

- **Status:** code committed on `claude-dev`; tests pass; checked read-only against Production data; not deployed
- **Status update 2026-11-11:** deployed to Production (`main` `041fc03`, build `20261111-claude-plan-3l`).
- **Files:** `app.js` (`activitiesHtml`, `activityRowsHtml`, `activityPresetRange`, `actFlows`), `style.css` (`.act-*`), `scripts/tests/activity.test.mjs`

## Problems

| Problem | Effect |
|---|---|
| No totals | You could not see money in, money out or net for what was on screen |
| Day headings were raw dates (`2026-11-05`), no month grouping | Hard to scan |
| A `×` delete button on every row | Easy to delete an entry by mistake |
| A card inside a card, and "Transactions" shown twice | Wasted space |
| All 596 rows rendered at once | Slow on phones |
| Filters were rebuilt from defaults whenever older transactions finished loading in the background | Search and filters reset while you were using them |
| Date presets used UTC (`toISOString`) | "Today" could be the wrong day in IST late at night |
| No way to find the 45 transactions without an account | — |

## Resolution

- **Period switch** at the top: This month (default), Last month, 3 months, All time. Today / 7 / 30 days and custom dates are under More filters. Dates use the local calendar.
- **Totals for the current filter:** Money in, Money out (says how much is investments and card payments), Net, and Transfers (between your own accounts, not counted as in or out). The split matches the account details page: in = income; out = expense + investment + liability.
- **Month headers** (sticky) with the month's in and out; **day headers** say "Today", "Yesterday" or "Sun, 8 Nov", with that day's in and out.
- **Rows:** coloured icon and signed amount by type; "No account" highlighted. Tap a row to see date, type, category, account and note. **Delete is only inside the opened row.**
- **Show more** loads 60 rows at a time.
- Filter state (`activityState`) survives re-renders, so background loading no longer resets it.
- New Account filter option: "No account linked".
- Build `20261111-claude-plan-3k`.

## Verification

- `scripts/tests/activity.test.mjs` (5 tests): this-month totals; day/month labels, signed amounts, delete only in the opened row; No-account filter, all time, paging; filters kept across re-render; local-date presets.
- Read-only render from Production data (2026-11-11), this month: 58 of 596 transactions; in +₹1,75,928.50, out −₹74,497.50 (incl. investments ₹16,267.15 and card payments ₹30,536.95), net +₹1,01,431.00, transfers ₹63,435.00.

## Noticed, not changed

- On 8 Nov there are interest income rows with no account ("November savings interest (incremental)", "November Atom interest (incremental)") next to the daily credit rows on the accounts. They may count the same interest twice in Money in. They need an owner decision (Plan 3 Phase 1 data quality).
