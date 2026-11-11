# 2026-11-11 — Dashboard Angel One "Today's gain" showed ₹0; invested and P&L came from a day-old snapshot

- **Status:** code committed on `claude-dev`; tests pass; checked read-only against Production data; not deployed
- **Related:** [Investments page from holdings](2026-11-11-investments-page-from-holdings.md)

## Symptoms

- Dashboard → Investments → Equity · Angel One showed **Today's gain ₹0**.
- The same card mixed sources: the current value used live prices (₹2,26,211), but invested, unrealised P&L (−₹14,792.80) and the per-stock LTP/P&L came from the Angel One snapshot of 10 Nov.

## Root cause

- The card read `todays_gain` from the latest saved Angel One snapshot (`angelone-equity-holdings-2026-11-10`), which stored `todays_gain: 0`.
- Prices are stored without a previous close, so the app could not compute the day's change.
- Tue 10 Nov 2026 was an NSE holiday (Diwali Balipratipada). The refresh at 05:03 IST on 11 Nov correctly returned Monday's close.

## Resolution

- `legacyPositionRows` (`api/_queries.js`) also returns `market_previous_close`: the last price in `wealth_instrument_prices` from **before the latest price's IST trading day**, plus `market_price_as_of`. That table keeps every quote from every writer (refresh job, ingest API, agents) through the 0006 mirror trigger, so the result does not depend on which writer stored the latest price. Holidays and weekends are handled: on 11 Nov the previous close is the 9 Nov close. If this query fails, the dashboard falls back to the previous query and day change shows "—".
- `app.js`: `dayChangeOf(p)` = quantity × (price − previous close), for fresh (under 36 h) INR stocks and funds only. `equityLive()` sums Indian equity holdings.
- The dashboard Angel One card uses live holdings for invested, P&L, the day's change and each stock row (LTP shows the % change today). The label is "Today's gain" when the latest price is from today (IST), otherwise "Day change · 9 Nov". When no previous close is known it shows "—", never ₹0. The snapshot is used only if there are no equity holdings in the database.
- Investments page: each stock shows "▲ +₹x today"; the group header shows the group's day change.
- Build `20261111-claude-plan-3l`.

## Verification

- `scripts/tests/daychange.test.mjs` (6 tests): holiday case (Monday close used, not an earlier same-day quote), no history, IST-midnight boundary, the client sum (stale and US prices left out), label, and the dashboard using live holdings.
- Read-only run on Production (11 Nov, prices of 10:26 IST): Angel One day change **+₹3,946.70** across 15 stocks (for example IRCTC +₹1,130.25, HDFCBANK +₹727.50, ITC +₹544.00, TATAGOLD −₹85.17). Mutual funds have no earlier NAV stored yet, so no day change is shown for them.

## Limitations

- The day change is only as current as the latest stored price (hourly agent / daily refresh), not tick-by-tick.
- A previous-day price stored mid-session (for example a 12:00 snapshot with no later quote that day) would be used as the "close". The nightly refresh normally stores the real close.
- US holdings have no day change: their session does not line up with the IST calendar day.
