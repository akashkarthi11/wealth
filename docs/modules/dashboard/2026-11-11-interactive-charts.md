# Interactive charts: tap to read, Period filter, zoom — 2026-11-11

**Status:** code on `claude-dev` (build `20261111-claude-plan-3t`), not deployed. Owner: "all chart touch to show data need, and filter and zoom in out too".

## Charts covered
Cash flow trend · Average monthly spend by year · Bank balance history (dashboard) · Interest by day (dashboard and Interest page) · share bars (investments and banks).

## Behaviour
- **Tap / hover / arrow keys:** a vertical crosshair snaps to the nearest date; one tooltip lists **every** series at that date (value first, then name; "Not recorded" for gaps). The Interest chart also shows the per-FD split.
- **Filter:** one **Period** row (3M · 6M · 1Y · All, default 1Y) above the trend charts scopes all of them. Cash flow now keeps its full history, so "All" works (1Y = the old "latest 12 months"). Interest by day keeps its daily range. Legend items toggle a series on/off (the last visible series cannot be hidden).
- **Zoom:** + / − / ⤢ (show all) buttons, pinch on touch; when zoomed, drag or swipe sideways to move; the toolbar shows the visible window ("5 Nov – 11 Nov · drag to move").
- **Share bars:** tap, hover or Enter on a segment shows "name · ₹amount · %".
- Axis values are compact (₹88.8K, ₹1.2L); tooltips keep the full value. Larger axis text on phones; vertical page scroll still works over a chart (`touch-action: pan-y`).
- Missing values break the line instead of drawing to zero. Tooltip text is set with `textContent`.

## Code
- One engine in `app.js` ("Interactive charts" block): `chartWidget`, `chartInnerHtml`, `chartVisible`, `chartShow`, `chartBindEvents`, `chartRangeRowHtml`, `chartAxisFmt`. `svgLineChart` now wraps it; Interest by day uses `interestChartDef`.
- Tests: `scripts/tests/charts.test.mjs` (5); `interest-fd.test.mjs` loads the engine. Full suite 160/160.
- Checked visually with headless Chrome at 540 px and 1000 px.

## Interest by day card redesign (build `3u`, owner: "interest by day in dashboard design need uiux")
- **Header:** month-to-date total (large) with "statement to … + daily after" or "earned this month"; "Nov to date · 3 sources".
- **KPI strip:** Latest day (total + date) · Daily average (last 7 days with data) · Projected for the month (MTD + average × remaining days, labelled an estimate).
- **Source rows** (Slice Savings, Atom, Fixed deposits): colour key, MTD amount, share %, share bar, rate (newest ledger rate; FDs as a range, e.g. 7.75–8% p.a.) and the per-FD split. Tapping a row shows/hides that line on the chart (replaces the chart legend; `data-chart-target`). Three columns on wide screens.
- **Tooltip** adds "Day total ₹…" before the FD split.
- **Method note** collapsed into "How this is calculated"; **"Interest details →"** on the dashboard only.
- Engine: optional `legend:false`, toggles from outside the chart kept in sync, x-axis labels never collide with the last label.
- Checked visually at 540 px and 1000 px; tests updated (`interest-fd.test.mjs` 7); full suite 160/160.

## Touch anywhere (build `3w`, owner: "chart only data show when click joint")
- Cause found: pages opened before the `3u` deploy kept the old charts (values only on a dot) until reloaded. The live `3u` charts already respond to a touch anywhere (checked with a real touch event in headless Chrome, mobile emulation: tapping an empty spot showed "Mar 2026 · ₹74,595 Money in · ₹47,855 Spending").
- Extra robustness: a transparent full-size hit layer (`.ichart-hit`) on every chart and a click fallback, so browsers that do not hit-test empty SVG areas (e.g. Safari) still show the nearest date.

## Ball on the touched point, auto-hide outside (build `3x`, owner: "when i touch outside it still show data … like in joint touch ball … touch outside it hide auto")
- Touching a chart puts a ball (series colour, white ring) on every visible line at that date; the tooltip sits beside the crosshair (right, or left near the edge) so the balls stay visible.
- Touching or clicking anywhere outside a chart closes its tooltip, crosshair and balls; outside a share bar closes its readout (`chartDismissOutside`, capture-phase `pointerdown`).
- Verified with real touch events in headless Chrome (mobile emulation): inside tap → tooltip + 2 balls; outside tap → all hidden.
