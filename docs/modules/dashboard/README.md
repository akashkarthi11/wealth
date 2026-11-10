# Dashboard module

The Home dashboard: wealth hero total, CASA / Investments / Liabilities cards, the investment breakdown, analytics charts and the view router.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/dashboard.js`](../../../api/_routes/dashboard.js) | `GET /api/dashboard` — single read of transactions, template, accounts, priced positions, interest ledger/statements, category symbols, and (admin only) snapshots |
| [`app.js`](../../../app.js) | `loadDashboard`, `wealthPosition`, `usHoldingInrValue`, `investmentBreakdownHtml`, `renderTopWealth`, `analyticsHtml`, `renderView` |
| [`index.html`](../../../index.html) | Shell markup; inline script hides `#stats` when the active view is not Overview |
| [`style.css`](../../../style.css) | All styling |

## Data flow

1. `showApp()` → `loadDashboard()` calls `/api/dashboard`, then `/api/planned-bills`.
2. The client drops any `*_ARCHIVED` position (the server already excludes them).
3. `wealthPosition()` derives every headline figure from `accounts` + `positions`:
   - **CASA** = verified INR savings/current accounts.
   - **Investments** = equity + mutual funds + gold + silver + FD + PF + US holdings (INR).
   - **Total** = CASA + Investments − Liabilities.
4. `renderTopWealth()` renders the hero and cards; tapping a card expands `wealthExpandedHtml(key)`.

## Rules

- `/api/dashboard` is **never served from Redis**. Financial totals must come from one fresh DB read (see the US-holdings incident).
- Server-side valuation: when a market price is `fresh`, < 36h old, currency matches and quantity is set, `current_value` is replaced with `quantity × unit_price`. `market_value_inr` is computed only when a fresh FX rate exists.
- All US holding INR values (summary, provider subtotal, rows) must go through `usHoldingInrValue()`.

## Known issues

- Equity and mutual-fund **detail rows** still read from snapshot `sourceSections`, while headline totals read live positions — rows may not sum to the header.
- INDmoney buying power is read from the `US_PORTFOLIO_INR` row, which is archived by migration in Production → shows ₹0.
- Chart tooltip click handler looks for `[data-chart-point]`, which the SVG markup never sets ([`app.js:278`](../../../app.js#L278)).
- `api/_routes/dashboard.js` runs `CREATE TABLE IF NOT EXISTS wealth_category_symbols` on every request.
- Retirement card hard-codes "₹93,726" and "31 Mar 2027".
- Branch `fix/net-worth-valuation-reconciliation` (unmerged) replaces `wealthPosition` with `calculateWealthTotals` and a confirmed-vs-reported net worth.

## Fix history

- [2026-11-10 — US holdings total mismatch](2026-11-10-us-holdings-total-mismatch.md)
