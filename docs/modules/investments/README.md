# Investments module

Holdings and their valuation: Indian equity (Angel One), mutual funds, US stocks/ETFs (INDmoney), fixed deposits, EPF/EPS/PPF, gold and silver.

## Files

| File | Responsibility |
|---|---|
| [`api/dashboard.js`](../../../api/dashboard.js) | `readPositions()` — joins positions → investment assets → market prices and computes live value |
| [`api/positions.js`](../../../api/positions.js) | `POST /api/positions` — create a manual Angel One fixed deposit |
| [`app.js`](../../../app.js) | `wealthPosition`, `usHoldingInrValue`, `investmentBreakdownDetailsHtml`, Investments view |
| [`scripts/migrations/`](../../../scripts/migrations/) | Position normalization and Angel One conversion migrations |

## Tables

- `wealth_positions` — canonical record per holding: `category` (`INVESTMENT` / `LIABILITY`), `record_type`, `name`, `ticker`, `currency`, `quantity`, `current_value`, `invested_value`, `balance_as_of`, `source_key`, `metadata`.
- `wealth_investment_assets` — one pricing mapping per position (`position_id` unique). Rows with `position_id IS NULL` are history-only trackers.

## Record types and how they are totalled

| Bucket | `record_type` | Currency |
|---|---|---|
| Equity | `EQUITY`, `STOCK`, `INDIAN_EQUITY`, `ETF` | INR |
| Mutual funds | `MUTUAL_FUND`, `MF` | INR |
| Fixed deposits | `FIXED_DEPOSIT` (excluded when `metadata.reconciliation_status='pending_reconciliation'`) | INR |
| Retirement | `EPF`, `EPS`, `PROVIDENT_FUND`, `PF`, `PPF` | INR |
| Gold / Silver | `GOLD`, `DIGITAL_GOLD` / `SILVER`, `DIGITAL_SILVER` | INR |
| US holdings | `US_EQUITY`, `ETF` | USD → INR via `usHoldingInrValue` |

Any `record_type` ending in `_ARCHIVED` is excluded everywhere (old portfolio aggregates kept only for audit).

## US holding INR precedence (`usHoldingInrValue`)

1. `market_value_inr` (fresh price × fresh FX, computed server-side)
2. `metadata.inr_conversion.current_value_inr`
3. `current_value` (USD) × `market_fx_to_inr` or `metadata.inr_conversion.usd_inr_rate`
4. Otherwise `0` — never invent an FX rate.

Covered by [`scripts/test-us-holdings-valuation.test.mjs`](../../../scripts/test-us-holdings-valuation.test.mjs).

## Known issues

- `POST /api/positions` rejects every maturity date: the regex is written `\\d` inside a regex literal ([`api/positions.js:16`](../../../api/positions.js#L16)).
- The FD creation endpoint is not called from the UI.
- Mutual-fund invested value and gain mix the snapshot "invested" figure with live NAV totals.

## Related

- [Market data](../market-data/README.md) · [Database](../database/README.md) · [US holdings total mismatch](../dashboard/2026-11-10-us-holdings-total-mismatch.md)
