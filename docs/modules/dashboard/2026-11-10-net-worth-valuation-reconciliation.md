# Net Worth Valuation and Reconciliation — Unverified Assets and Aggregate Double Counting

- **Date:** 2026-11-10
- **Primary module:** Dashboard
- **Related modules:** Investments, Accounts, Liabilities, Market Data, Database
- **Status:** Code committed on feature branch; regression tests added; Development build/deployment and post-deploy verification pending
- **Branch:** `fix/net-worth-valuation-reconciliation`
- **Related incident:** [US holdings total mismatch](2026-11-10-us-holdings-total-mismatch.md)

## Symptoms

The Home dashboard presented the Investment breakdown as a single authoritative total and calculated net worth as CASA + investments − liabilities. The stored data included a future-dated EPF/EPS passbook balance, an FD balance awaiting reconciliation, US holdings valued using saved reference FX, an older credit-card balance, and an active Angel One equity aggregate alongside its individual stock rows.

## Expected behavior

- The confirmed net-worth figure must exclude assets whose value is explicitly unverified or pending reconciliation, while still showing those reported balances separately.
- A reported total must remain available for comparison; the UI must explain the difference between reported and confirmed totals.
- Individual holdings take precedence over portfolio aggregate rows. Aggregates are fallback-only when no individual rows exist for that asset class.
- Archived aggregate rows are never counted.
- INDmoney buying power is foreign cash, not an investment holding and not a second copy of the account total.
- Liabilities must show their actual saved balance and timestamp, with stale status surfaced.
- Every total uses paise-rounded arithmetic and the same included-record rules.

## Confirmed Development data findings

Read-only audit of Development project `cold-smoke-05088150`, database `neondb`, user portfolio:

1. **Retirement:** EPF/EPS combined record is ₹93,726. Its metadata carries a future displayed passbook date of 31 March 2027 and an explicit warning that the value is not a verified current valuation.
2. **Fixed deposits:** Slice FD is ₹3,001 with `balance_reconciliation_required`; the related account record is pending reconciliation. Angel One FD is a separate ₹1,000.87 position. The unverified Slice balance must remain visible but not inflate confirmed net worth.
3. **US holdings:** Five individual USD positions are present. Their INR metadata uses a saved reference FX rate; where there is no fresh timestamped INR market valuation, this remains a reference value and is excluded from confirmed net worth.
4. **Foreign cash:** INDmoney buying power is a cash balance and must be counted separately from the USD security holdings. The INR portfolio aggregate is not an extra security position.
5. **Credit card:** ₹30,634.21 is the last saved liability value, dated 8 November 2026; show it as last-known and flag it as older than 48 hours.
6. **Bank balances:** Five domestic savings/current accounts sum to ₹1,13,383.53. The Atom and Slice values are newer than the other three balances; older verified balances are flagged as stale.
7. **Duplicate aggregates:** An active Angel One equity portfolio aggregate of ₹2,21,394 is stored as `EQUITY` alongside individual equity rows. An Angel One mutual-fund aggregate is also present. These are not separate assets and must not be added when individual rows exist.
8. **Missing price mappings:** The two Development positions without mappings are the equity and mutual-fund aggregate records, not missing individual security mappings. Do not create price assets for those aggregate rows.

No Development or Production database rows were changed during this implementation.

## Resolution

- Added a pure `calculateWealthTotals` function as the single calculation path for the Home dashboard wealth cards.
- Uses only verified INR savings/current accounts for CASA; card accounts and FD accounts are not misclassified as cash.
- Excludes archived records and uses individual equity / mutual-fund rows in preference to active aggregate rows. Aggregate values are used only if no individual rows exist.
- Keeps reported EPF/EPS and pending FD values visible, but deducts those amounts from confirmed net worth pending verification.
- Keeps US holding values based on saved FX visible as reference values, but deducts them from confirmed net worth until a fresh timestamped INR valuation exists.
- Counts INDmoney buying power as separate foreign cash and does not count the US portfolio aggregate as a security.
- Deducts the saved credit-card liability and exposes its saved date in the liabilities detail.
- Flags bank balances, metals valuations and liabilities older than 48 hours.
- Uses integer paise rounding for component totals.
- Added regression tests for retirement and FD exclusions, reference-FX values, foreign cash, liabilities, and aggregate-vs-individual precedence.
- Added the regression test command to the build script so Vercel preview builds fail on calculation regressions.

## Verification

- [x] Development database read-only audit completed.
- [x] Root causes documented with affected record classes.
- [x] Shared wealth totals calculator committed.
- [x] Tests added for the reconciliation rules and aggregate de-duplication.
- [x] Build script runs the valuation regression suite.
- [ ] Execute regression suite in CI / preview build.
- [ ] Complete Development UI and build verification.
- [ ] Verify the live Development dashboard against the same database snapshot.
- [ ] Production untouched; separate approval required for any future Production change.

## Deployment

The user explicitly requested this fix in Development. A feature branch and PR target the Development branch. No Production deployment or database mutation is authorized by this request.
