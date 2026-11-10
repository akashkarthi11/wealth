# Wealth Reliability & Data Integrity

**Status:** Active engineering work  
**Repository:** `akashkarthi11/wealth`  
**Scope:** Development and Production databases, API valuation logic, market-price refresh, dashboard aggregation, and regression tests.

## Mission

Keep every displayed wealth value consistent with the underlying records. A holding must never silently disappear from a subtotal, be counted twice, or change value because different screens use different fallback rules.

This is a reliability project, not a one-time dashboard correction.

## Non-negotiable invariants

1. **One source of truth per holding.** Position records are canonical for quantity, cost basis, currency, and ownership. Price records provide market prices and timestamps. Derived values must be calculated consistently from these sources.
2. **Every investment position is accounted for.** Each eligible listed asset must have a valid investment-asset mapping and a defined pricing state. Missing mappings must be visible as errors, not silently excluded.
3. **One valuation rule everywhere.** Holding rows, provider subtotals, investment breakdowns, dashboard totals, and net wealth must use the same valuation service/rules.
4. **No stale price presented as fresh.** Every quote has a source, currency, fetched timestamp, and status. Stale or failed quotes are clearly flagged and handled by an explicit fallback policy.
5. **FX must be auditable.** USD values converted to INR require a valid USD/INR rate, source, and timestamp. Never label a hard-coded or old reference rate as live.
6. **No duplicate aggregation.** Archived aggregate rows and their underlying positions must not both contribute to totals. Ownership and active/archive status must be respected.
7. **Totals must reconcile.** Investment category totals equal their included holding/provider totals. Total assets equal CASA plus investments and other included assets. Net wealth equals total assets less liabilities.
8. **Cache cannot change financial correctness.** Cache invalidation and refresh failures must never cause one dashboard section to use a different portfolio snapshot from another.

## Known incident and regression case

The November 10, 2026 US-stock update exposed inconsistent aggregation:

- NVIDIA appeared in the US holdings list but was omitted from the INDmoney INR detail subtotal when its linked pricing-asset record was missing.
- The main investment total used a different fallback, so the dashboard sections disagreed.
- Stale dashboard caching could temporarily serve an older set of positions.
- A missing asset-to-price mapping was not surfaced as a data-integrity failure.

The regression suite must retain this case: five US holdings (GOOGL, NVDA, BKSY, AVGO, QQQ), including a position with no pricing mapping and a position with a stale quote. Expected behavior is an explicit integrity warning and consistent, documented valuation—not silent omission.

## Workstreams

### 1. Data model integrity

- Enforce one investment-asset mapping per eligible position (unique constraint on the appropriate position key).
- Add/verify foreign keys and ownership consistency between positions, investment assets, and market prices.
- Validate required fields by asset class: symbol, currency, quantity unit, source symbol, and pricing status.
- Detect duplicate active positions and archived aggregate rows that could double-count balances.
- Provide a safe, repeatable reconciliation script. It must report proposed inserts/updates before mutation and be idempotent.

### 2. Centralized valuation

- Implement or maintain one shared valuation function/service used by all dashboard endpoints and UI breakdowns.
- Distinguish asset classes and units. Do not apply equity share pricing to metals, deposits, retirement balances, or unsupported assets.
- For listed holdings, calculate from valid quantity and matching-currency unit price when the quote is fresh.
- For USD holdings, convert to INR only with a valid, timestamped FX quote; retain original USD values.
- Make fallback behavior explicit per asset class. Never mix a saved INR snapshot, stale FX, and live USD quote without recording the valuation basis.
- Return valuation metadata: source, quote timestamp, FX timestamp, freshness, and fallback reason.

### 3. Dashboard reconciliation

- Derive all cards, provider summaries, holding rows, and net-worth totals from one consistent response/snapshot.
- Ensure each included position contributes exactly once.
- Display missing-price, missing-mapping, stale-price, and missing-FX states rather than quietly dropping rows.
- Add a reconciliation section (or diagnostics endpoint) showing component totals and any difference.
- Use decimal-safe arithmetic and round only at presentation boundaries.

### 4. Market-price and FX refresh

- Record source, source symbol, quote currency, fetched time, and status for every refresh.
- Do not mark a quote fresh when the quote or required FX rate failed.
- Invalidate all relevant dashboard cache versions after successful updates.
- Alert on failed refreshes, stale quotes, missing FX, unexpected price jumps, and incomplete asset coverage.
- Never overwrite a valid last-known quote with null, zero, or malformed data.

### 5. Cache and snapshot consistency

- Treat financial dashboard responses as versioned snapshots.
- Ensure every dashboard section in one response uses the same snapshot/version.
- Invalidate cache keys whenever positions, mappings, prices, FX, or liabilities change.
- Prefer bypassing cache for correctness-critical reads until snapshot-based caching is proven safe.
- Add tests for stale-while-revalidate races and cache-version changes.

### 6. Automated tests and CI gates

Required tests:

- [ ] All active eligible positions have exactly one valid pricing-asset mapping.
- [ ] Missing mapping is detected and surfaced.
- [ ] Missing/stale market price is surfaced and never represented as fresh.
- [ ] USD holding with valid FX converts correctly; missing/stale FX is flagged.
- [ ] Quantity × unit price produces the expected holding value.
- [ ] Metals and other non-share assets use their own unit/valuation rules.
- [ ] Archived aggregate records are excluded when underlying records are present.
- [ ] No position is counted twice across provider and category summaries.
- [ ] Sum of holding values equals provider subtotal.
- [ ] Sum of provider/category subtotals equals investment total.
- [ ] CASA + investments + other included assets − liabilities equals net wealth.
- [ ] Cache invalidation refreshes the dashboard after a position, mapping, quote, or FX change.
- [ ] The five-US-holding November 10 regression case passes.

CI must run schema checks, unit tests, integration tests, and build validation before a change is considered ready.

## Reconciliation and monitoring

Run a read-only integrity audit on both Development and Production and report:

- Active positions without asset mappings.
- Asset mappings without valid positions.
- Positions with missing or duplicate market-price records.
- Stale or missing prices and FX.
- USD positions missing INR valuation metadata where required.
- Duplicate/archived rows that could affect totals.
- Differences between row sums, provider sums, category sums, total assets, and net wealth.

Every discrepancy should include the affected record IDs, ticker/asset, expected value, actual value, and proposed repair. Do not auto-delete or silently rewrite financial history.

## Release and environment safety

1. Make code and schema changes on a feature branch.
2. Run automated tests and read-only reconciliation first.
3. Apply additive, reversible migrations to Development.
4. Verify all holding rows and dashboard totals against database calculations.
5. Obtain explicit user approval before any deployment.
6. Obtain explicit user approval before Production database mutations or deployment.
7. After approval, deploy Development first, verify it, then request separate approval for Production.
8. Record commit SHA, migration identifier, test results, reconciliation results, and deployment status.

**Hard rule:** Never deploy to Development or Production without asking and receiving explicit approval for that specific deployment. Never merge a PR or make Production changes based on an assumed approval.

## Definition of done

This project is complete only when:

- The data model prevents or detects missing/duplicate asset mappings.
- All dashboard totals use one consistent valuation and aggregation path.
- Missing/stale prices and FX are visible and auditable.
- Reconciliation checks pass in both environments.
- Regression tests cover the November 10 NVIDIA omission and related cache behavior.
- CI blocks changes that violate the invariants.
- The user has explicitly approved any deployment; no deployment is implied by code completion.

## Current work log

### 2026-11-10

- Recorded the US-stock subtotal mismatch and stale dashboard response incident.
- Added/verified missing US investment-asset mappings for the affected holdings in Development and Production.
- Updated the feature branch `fix/market-price-wealth-total` with dashboard valuation fallback and fresh-read changes.
- **Not deployed.** Deployment requires explicit approval.
- Next: validate the complete branch diff, add automated reconciliation/regression tests, and verify database totals against a single canonical valuation calculation before requesting Development deployment approval.
