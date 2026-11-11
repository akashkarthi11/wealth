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
