# FD interest not calculated / not shown on the Interest page — 2026-11-11

**Status:** in Production. `main` `8edae9b` (build `20261111-claude-plan-3o`); data fix applied after owner approval ("approve to dev merge to main").

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

## Production (2026-11-11)
- Backup `prod-before-fd-terms.wlb` (32 tables, 5,736 rows); repair: terms UPDATE 2, rate periods UPDATE 2, Slice FD value UPDATE 1 (₹3,005.04), Angel One FD value UPDATE 1 (₹1,001.30).
- Accrual 5–10 Nov written as owner: Slice FD 6 rows ₹3.82, Angel One FD 6 rows ₹1.32; a re-run writes 0. The nightly job continues from 11 Nov.

## Two FDs shown separately (2026-11-11, owner: "check fd in intrest beacause we have 2 accounts")
- **Bug:** the Fixed deposits box skipped positions flagged `historical_snapshot`; the Angel One FD carries that flag from its screenshot import, so only Slice FD (₹4.04) was shown. The dashboard already counted both. The filter is removed (pending-reconciliation FDs are still left out).
- **Split per FD:** each FD row shows current value, invested and the interest this app calculated for that FD (matched by account key); the daily list shows "Angel One FD ₹0.22 · Slice FD ₹0.64" under the FD amount; the chart legend shows the month total per FD.
- Production data checked (read-only): both FDs have 6 accrual days, 5–10 Nov — Slice FD ₹3.82, Angel One FD ₹1.32.
- Build `20261111-claude-plan-3s` on `claude-dev`; tests `interest-fd.test.mjs` (7).
