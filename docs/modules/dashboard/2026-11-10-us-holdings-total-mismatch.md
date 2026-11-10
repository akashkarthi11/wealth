# US Holdings Total Mismatch — NVIDIA Omitted from INR Breakdown

- **Date:** 2026-11-10
- **Primary module:** Dashboard
- **Related modules:** Investments, Market Data, Database
- **Status:** Code committed on feature branch; database mappings repaired in Development and Production; not deployed; end-to-end verification pending
- **Branch:** `fix/market-price-wealth-total`
- **Related PR:** [#33](https://github.com/akashkarthi11/wealth/pull/33)

## Symptoms

The US holdings list showed NVIDIA, but the INDmoney US-stock INR breakdown did not include its value. The investment breakdown and dashboard totals therefore disagreed. The screenshots showed a difference of approximately ₹746.74, matching the displayed NVIDIA holding value converted using the stored reference FX rate. Dashboard values could also change after refresh because stale cached positions were served.

## Expected behavior

- Every active US holding appears exactly once in the US provider subtotal.
- Holding detail, provider subtotal, investment total and net wealth reconcile from the same valuation basis.
- A missing pricing-asset mapping or stale quote is surfaced as an integrity issue, never silently omitted.
- All dashboard sections in one response represent a consistent portfolio snapshot.

## Confirmed root causes

1. The UI subtotal reduced only over `market_value_inr` and then fell back to a provider aggregate only when the entire row sum was zero. A holding with a missing `market_value_inr` was silently omitted whenever other holdings had values.
2. The main portfolio total used a different fallback calculation, so the two sections could disagree.
3. The US holding positions did not all have corresponding `wealth_investment_assets` records. NVIDIA's missing mapping prevented the market-price refresh pipeline from associating a quote with it.
4. Dashboard caching could serve stale position snapshots, delaying visibility of database changes.

## Related prior fixes reviewed

- Reviewed the system-wide rules in [Wealth Reliability & Data Integrity](../../WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md).
- This incident is the first canonical record in this module history. No earlier dashboard issue note was found in the existing documentation paths checked.
- Decision: treat this as a cross-layer consistency defect, not as a one-off NVIDIA data problem. Future recurrences must be appended here unless investigation proves a materially different root cause.

## Resolution recorded

### Database repair

- Added missing `wealth_investment_assets` mappings for eligible US holdings in both Development and Production.
- Specifically, NVIDIA's missing mapping was created in both environments; Broadcom's missing mapping was created in Development.
- Five holdings were checked: GOOGL, NVDA, BKSY, AVGO and QQQ.
- The repair was performed against the existing positions; no deployment was performed.

### Code changes committed

- Dashboard API was changed to read current financial dashboard data directly rather than returning stale Redis dashboard snapshots.
- US holding detail subtotal now applies a per-row INR fallback using `market_value_inr`, saved INR conversion metadata, or USD value multiplied by the available FX reference.
- Holding-row INR display uses the same fallback chain.
- Client build identifier was updated.

## Important valuation caveat

The screenshot-derived INR conversion used a stored reference FX value of 93.93 INR/USD. This is not proof of a live FX quote. Do not describe that conversion as current/live. The market-data pipeline must provide a timestamped FX quote before a value can be marked as live. The code and data model should keep original USD values and INR conversion provenance.

## Verification

- [x] Five US position records exist in both Development and Production.
- [x] Missing investment-asset mappings identified and inserted in both environments.
- [x] Code changes committed on the feature branch.
- [ ] Automated regression test for a partially missing `market_value_inr` field.
- [ ] Automated test for missing investment-asset mapping.
- [ ] Automated test for stale dashboard cache / snapshot consistency.
- [ ] Run full reconciliation of holding rows, provider subtotal, investment total and net wealth in Development.
- [ ] Verify the deployed Development build after explicit approval.
- [ ] Production deployment and verification only after separate explicit approval.

## Deployment and approval

**Not deployed.** The user requires explicit approval before any Development or Production deployment. PR merge is also not implied by this documentation or by code completion.

## Recurrence handling

If the same symptom appears again:

1. Read this note and the [fix index](../../index.md) before changing anything.
2. Compare the affected ticker/position IDs, asset mappings, price freshness, FX provenance, API response and UI subtotal inputs.
3. Determine whether the old root cause has returned or a different defect exists.
4. If it is the same root cause, append a dated recurrence entry below and update the verification checklist; do not create a duplicate note.
5. If the root cause is materially different, create a new module note and cross-link both records in the index.
6. Add a regression test for every confirmed recurrence.

## Recurrence log

_No recurrence recorded after the initial incident._
