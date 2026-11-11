# 2026-11-11 — Investments menu total did not match the dashboard; holdings came from snapshots

- **Status:** code committed on `claude-dev`; tests pass (117); checked read-only against Production data; not deployed
- **Status update 2026-11-11:** deployed to Production (`main` `041fc03`, build `20261111-claude-plan-3l`).
- **Plan:** follows the bank page fix ([accounts](../accounts/2026-11-11-bank-balances-live-and-account-details.md)): pages come from the tables, no static data

## Symptoms

- Investments menu "TOTAL INVESTED" showed **₹20,272**. The dashboard INVESTMENTS card showed **₹3,83,641**.
- The 15 Indian stocks, 4 mutual funds, gold, silver, EPF and US holdings were not listed from the database; the page showed old snapshot tables.

## Root cause

- The page added up investment **transactions** (money put in, ₹16,267) plus the FD current value. That is a cash-flow figure, not the current value of the holdings.
- Holdings came from saved snapshot sections (`isInvestmentRecord`), not `wealth_positions`.

## Resolution

- New `investmentsPageHtml()` / `investmentsPageModel()` in `app.js`, built from the same `positions` (`legacyPositionRows`) and the same rules as `wealthPosition()`. Its total is `wealthPosition().investments`, so it equals the dashboard by construction.
- Groups (largest first): Indian stocks, Retirement (EPF / PPF), Gold, Mutual funds, Silver, US stocks, Fixed deposits. Each holding row shows quantity × price, value, gain/loss (₹ and %), and the price basis: **Live** (fresh, under 36 h), **Old price**, or **Saved value**, with time and source. US holdings show ₹ and $.
- Holdings the dashboard does not count (FD pending reconciliation, no value) are listed by name under "Not counted".
- "Money put in" (investment transactions) is a separate section and is not added to the value.
- Snapshot records stay under Tools → Other records. Build `20261111-claude-plan-3j`.

## Verification

- `scripts/tests/investments.test.mjs` (4 tests): page total = `v1Totals(...).investments` (the server port of the dashboard); each group's rows add up to its total; price tags, units, US ₹/$, gains/losses, "Not counted", no snapshot markup; money put in kept separate.
- Read-only render from Production data (2026-11-11): page ₹3,83,641.07 = dashboard ₹3,83,641.07; equity 15 holdings ₹2,26,211.03, EPF ₹93,726.00, gold ₹29,416.02, MF 4 ₹13,226.43, silver ₹11,688.27, US 5 ₹5,367.82, FD 2 ₹4,005.50; nothing excluded.

## Known limitations

- Uses the v1 data model (Production default). With `?model=v2` the dashboard card uses v2 totals; this page still shows v1 holdings.
- A price hold (Plan 3 DQ-1, `wealth_instruments.price_hold_reason`) is not shown on the row, because the v1 payload does not carry it.
