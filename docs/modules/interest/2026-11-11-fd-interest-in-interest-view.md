# FD interest not calculated / not shown on the Interest page — 2026-11-11

**Status:** code on `claude-dev` (build `20261111-claude-plan-3o`, not deployed); data fix prepared and rehearsed on Development, **waiting for owner approval for Production** ("approve fd interest fix").

## Problem (owner: "fd intrest not calculated", "it need to show in intrest menu and intrest by day flowchart")
1. **No calculation.** Slice FD and Angel One FD were linked to interest products with rates (7.75%, 8%), but had no FD terms (principal, start date, payout). `planAccrual` returns `pending_terms`, so the nightly job wrote nothing. Both rate periods also started on 10 Nov, after the FDs were booked.
2. **Not shown.** The Interest page knew only two series (Slice Savings, Atom). Any other product's ledger row was put into the "savings" series and **overwrote** that day's Slice Savings value. The FD box showed only `metadata.interest_earned_inr` from screenshots (₹0 for Slice FD, which has none).

## Data fix — [`2026-11-11-fd-terms.sql`](../../../scripts/db/repairs/2026-11-11-fd-terms.sql)
Fills only empty fields; nothing deleted; re-run changes nothing.
| FD | Principal | Rate | Start | Payout | Maturity | Value (owner, 11 Nov) |
|---|---|---|---|---|---|---|
| Slice FD | ₹3,001 | 7.75% | 5 Nov 2026 | cumulative, quarterly | not known | ₹3,005.04 |
| Angel One FD (Unity SFB) | ₹1,000 | 8% | 5 Nov 2026 | cumulative, quarterly | not known | ₹1,001.30 |

Evidence for the start date: Angel One ₹1.09 interest on 10 Nov = 5 days at 8%; ₹1,000 paid to Unity Small Finance Bank on 5 Nov; Slice FD ₹3,004.41 → ₹3,005.04 is one day at 7.75%. Payout and "no maturity" are the owner's answers. Each FD's rate period now starts on its booking day.
Development: terms UPDATE 2, rates UPDATE 2, values UPDATE 1+1, re-run 0; accrual dry run 5–10 Nov: Slice FD ₹3.82, Angel One FD ₹1.32.

## Code fix — `app.js`, `style.css`
- `interestSeriesKey(product)`: `atom-savings` → atom, product keys ending in `fd` → **fd** (all FDs summed per day), others → savings. FD rows no longer overwrite savings.
- Interest by day: third amber line "Fixed deposits", legend amount, and FD month-to-date included in the total.
- Daily list: a "Fixed deposits" entry per day with a running total (only when FD rows exist).
- FD box: app-reported interest, or current − invested when no figure was recorded; plus "calculated by this app since start".
- Tests: `scripts/tests/interest-fd.test.mjs` (6). Full suite 142/142.
