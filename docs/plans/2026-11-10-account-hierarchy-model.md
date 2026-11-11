# Account Hierarchy Data Model

- **Date:** 2026-11-10
- **Status:** Implemented as migrations 0003–0004 and the v2 dashboard ([Plan 1](claude-plan-1.md) Phase 5); in Production since 2026-11-10
- **Replaces:** Stage 3 of the [Data normalization design](2026-11-10-data-normalization-design.md)

## Shape

```
user
 └─ account                       one row per real account (user_id is stored only here)
     ├─ type      CASA | INVESTMENT | LIABILITY    (from the subtype)
     ├─ subtype   savings, demat_equity, credit_card, …
     └─ data      whatever the account has — empty is fine
         ├─ balances      cash, FD/EPF value, broker cash, or amount owed (history)
         ├─ holdings      units of an instrument (stocks, funds, metals)
         └─ transactions  money movements (existing table)

instrument (shared by everyone: LT, NVDA, Nippon Large Cap, GOLD …)
 └─ prices        price history, stored once per instrument
```

## Sample — today's data in this shape

Read-only preview from the Preview database ([`scripts/db/preview-account-hierarchy.sql`](../../scripts/db/preview-account-hierarchy.sql)):

| Type | Subtype | Account | Data |
|---|---|---|---|
| CASA | savings | Atom · Atom Savings | balance ₹63,420.00 (verified) |
| CASA | savings | Bank of India · Savings ••4556 | balance ₹1,426.99 (verified) |
| CASA | savings | HDFC Bank · Savings ••9498 | balance ₹3.89 (verified), 1 transaction |
| CASA | savings | Roarbank · Savings | balance ₹650.65 (verified) |
| CASA | savings | Slice · Savings ••3731 | balance ₹47,882.00 (verified), 8 transactions |
| INVESTMENT | demat_equity | Angel One · Stocks & ETFs | 15 holdings (LT, HAL, RELIANCE, ITC, …) |
| INVESTMENT | mutual_fund | Angel One · Mutual funds | 4 holdings |
| INVESTMENT | us_brokerage | INDmoney · US stocks & ETFs (USD) | 5 holdings (AVGO, BKSY, GOOGL, NVDA, QQQ) + cash $10.02 |
| INVESTMENT | digital_gold | Paytm Gold | 1 holding (2 g) |
| INVESTMENT | digital_silver | Paytm Silver | 1 holding (59.25 g) |
| INVESTMENT | fixed_deposit | Slice · Slice FD | balance ₹3,004.41 |
| INVESTMENT | fixed_deposit | Angel One · Angel One FD | balance ₹1,001.09 |
| INVESTMENT | provident_fund | EPFO · EPF / EPS | balance ₹93,726 (reported, future-dated) |
| LIABILITY | credit_card | Slice · Credit Card ••6136 | outstanding ₹30,634.21, 498 transactions |
| LIABILITY | credit_card | HDFC Swiggy Orange ••9229 | no balance yet, 42 transactions |

14 accounts, every current record placed once. Removed as duplicates: the `fixed-deposits` account row (copy of the two FDs, kept as `merged`), the separate credit-card LIABILITY position (now the card account's balance). 45 transactions whose source never named an account keep `account_id = NULL`.

## Tables

| Table | Primary key | Foreign keys | Holds |
|---|---|---|---|
| `wealth_account_subtypes` | `code` | — | Subtype → category (CASA/INVESTMENT/LIABILITY), and whether it is valued by `balance` or `holdings` |
| `wealth_accounts` (existing) | `id`; unique `(user_id, account_key)` | `user_id` → users, `subtype_code` → subtypes | Institution, name, masked number, currency, status |
| `wealth_account_balances` | `(account_id, as_of)` | `account_id` → accounts | Balance history; status `verified` / `reported` / `pending_reconciliation` |
| `wealth_instruments` | `id`; unique `(asset_class, symbol)` | — | Security / fund / metal, currency, unit, price source |
| `wealth_instrument_prices` | `(instrument_id, as_of, source)` | `instrument_id` → instruments | Price history; `fx_to_inr` for USD |
| `wealth_holdings` | `(account_id, instrument_id)` | accounts, instruments | Quantity, invested value |
| `wealth_transactions` (existing) | `id` | `(user_id, account_id)` → accounts | Unchanged |

The composite primary keys are what stop duplicates: an account cannot hold the same instrument twice, cannot have two balances at the same moment, and an instrument cannot have two prices from the same source at the same time.

Read model (views): `wealth_v_latest_prices`, `wealth_v_latest_balances`, `wealth_v_account_values` (per account: cash/outstanding, holdings value, holdings value in INR, priced vs total holdings).

**Net worth** = Σ CASA balances + Σ INVESTMENT (balances + holdings in INR) − Σ LIABILITY balances. One query, one rule.

## What this replaces

| Today | New model |
|---|---|
| `wealth_positions` (holdings, FDs, EPF, liabilities and archived aggregates mixed; state in `record_type` suffix) | `wealth_holdings` + `wealth_account_balances` under typed accounts |
| `wealth_investment_assets` (per-user copy of each security) | `wealth_instruments` (shared) |
| `wealth_market_prices` + `wealth_price_history` (latest stored twice) | `wealth_instrument_prices` + view |
| `wealth_accounts.current_balance` / `balance_as_of` / `balance_status` | `wealth_account_balances` (history instead of one overwritten value) |
| Credit card as a LIABILITY position + `liability` transaction | Balance on the credit-card account |
| INDmoney cash on an archived aggregate row | Balance on the INDmoney account |

Kept for audit until a later, separately approved drop: `wealth_positions`, `wealth_investment_assets`, `wealth_market_prices`, `wealth_price_history`, and the balance columns on `wealth_accounts`.

## Scripts (drafts, not run by `migrate-db.mjs`)

1. [`account-hierarchy-1-schema.sql`](../../scripts/migrations/0003_account_hierarchy.sql) — subtype catalogue, new tables, views. Additive only.
2. [`account-hierarchy-2-backfill.sql`](../../scripts/migrations/0004_account_hierarchy_backfill.sql) — copies data in, idempotent, and **aborts the whole transaction** if any active holding or balance was not carried over.

Both parse against Neon (checked in read-only transactions). A full run has not happened yet: it needs a Neon branch with write access.

## App changes after the data is in

- `api/dashboard.js`: read `wealth_v_account_values` grouped by category/subtype instead of joining positions → assets → prices.
- `api/refresh-market-prices.js`: write to `wealth_instrument_prices` per instrument (once, not per user), including `fx_to_inr`.
- `app.js`: build CASA / Investments / Liabilities cards and the breakdown from the account list; drop `wealthPosition` special cases (aggregate fallbacks, archived-row lookups, metadata FX).
- `api/positions.js`: "add FD" creates an account (`fixed_deposit`) plus a balance row.

## Rollout

Neon branch: schema → backfill → compare `wealth_v_account_values` totals with today's dashboard → Development (approval) → switch API reads → Production (separate approval) → later, drop legacy tables (separate approval).
