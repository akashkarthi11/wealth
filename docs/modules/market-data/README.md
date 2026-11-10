# Market data module

Quotes, mutual-fund NAVs, FX and price freshness.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/refresh-market-prices.js`](../../../api/_routes/refresh-market-prices.js) | Cron job: refreshes every asset with `pricing_status IN ('active','pending','stale')` |
| [`api/_routes/dashboard.js`](../../../api/_routes/dashboard.js) | Applies fresh prices when reading positions |
| [`vercel.json`](../../../vercel.json) | Cron schedule `0 23 * * *` (23:00 UTC = 04:30 IST) |

## Sources

| Asset class | Source | Symbol |
|---|---|---|
| Indian equity | Yahoo Finance chart API | `<TICKER>.NS` |
| US equity / ETF | Yahoo Finance | ticker |
| Gold / Silver | Yahoo `GC=F` / `SI=F`, converted USD/oz → INR/g using `INR=X` and 31.1034768 g/oz | — |
| Mutual funds | MFAPI.in (`/mf/search`, `/mf/{code}/latest`) | scheme code (resolved once, then saved to `price_source_symbol`) |
| USD/INR | Yahoo `INR=X` | — |

## Tables

- `wealth_market_prices` — latest price per asset (`asset_id` unique): `unit_price`, `currency`, `source`, `source_timestamp`, `fetched_at`, `status` (`fresh`/`stale`/`error`/`manual`), `metadata` (`fx_to_inr`, `fx_as_of`, `pricing_basis`).
- `wealth_price_history` — append-only history.

## Rules

- Auth: `Authorization: Bearer $CRON_SECRET`.
- A USD asset is not refreshed without an FX quote; failures mark the price `stale`.
- Dashboard treats a price as usable only if `status='fresh'` and `fetched_at` < 36 hours old; FX must also be < 36 hours old.
- Successful refreshes invalidate the user's Redis caches.

## Known issues

- **Every Production deploy overwrites live Angel One prices** with old snapshot LTPs marked `fresh` (`ON CONFLICT DO UPDATE` in `2026-11-10-convert-angelone-equity-to-live-positions.sql`).
- **Every deploy resets mutual-fund `price_source_symbol`** to the scheme name and `pricing_status` to `pending` (`2026-11-10-investment-position-normalization.sql`), forcing a fresh scheme search each run.
- Yahoo Finance is an unofficial endpoint with no SLA.
- No alerting on failed refreshes, stale quotes, or unexpected price jumps.
