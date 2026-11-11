# Dashboard v2 (account model) is the default — 2026-11-11

**Status:** code on `claude-dev` (build `20261111-claude-plan-3r`), not deployed. Owner: "set v2 default", "no i mean dasboard v2".

## Change
- `dashboardModel(env)` in `api/_lib.js`: the dashboard uses the account model (v2) unless `WEALTH_DASHBOARD_MODEL=v1` (and `WEALTH_DATA_MODEL=v2` always means v2). `/api/health` reports it as `config.dashboardModel`.
- `/api/dashboard`: v2 by default; the owner can compare with `?model=v1` (or force `?model=v2` when the default is v1).
- More menu (owner): "Compare with old dashboard (v1)" / "Back to the v2 dashboard".
- **Not changed:** `dataModel()` (`WEALTH_DATA_MODEL`, default v1) still decides where new records are written (e.g. "Add FD" creates a legacy position), so pages still on v1 keep seeing new data.

## Known differences at the switch (Production, read-only reconcile, 2026-11-11)
Net worth v1 ₹4,66,259.21 → v2 ₹4,59,756.65 (−₹6,502.56); `acceptable` = false. The owner chose to switch anyway.
| Area | v1 | v2 | Reason |
|---|---|---|---|
| CASA | ₹1,13,400.31 | ₹1,08,400.31 | Slice Savings mismatch (Plan 4 D0): v2 uses ₹42,889.22, v1 ₹47,889.22 |
| Digital gold | ₹29,416.02 | ₹28,484 | v1 = Paytm displayed value; v2 = 2 g × IBJA 999 benchmark |
| Digital silver | ₹11,688.27 | ₹11,020.52 | same basis difference (59.25 g) |
| Credit card owed | ₹30,634.21 | ₹30,536.95 | statement outstanding vs cycle liability (DQ-9) |
| MF / US | — | — | rounding (< ₹1) |

Revert without a code change: set `WEALTH_DASHBOARD_MODEL=v1` in Vercel (Production) and redeploy.
Tests: `scripts/tests/dashboard-model.test.mjs` (3); full suite 154/154.
