-- Repair (TSD TR-3.6): prices that were seeded by hand or from broker snapshots are not live market data.
-- Mark them 'manual' so the dashboard no longer presents them as fresh quotes. The refresh job
-- (Yahoo Finance / MFAPI.in) sets 'fresh' again when it writes a real quote.
-- Run: node scripts/db/run-sql.mjs <env-file> scripts/db/repairs/2026-11-10-mark-seeded-prices-manual.sql --apply --yes
BEGIN;

UPDATE wealth_market_prices
SET status = 'manual',
    metadata = metadata || jsonb_build_object('previous_status', status, 'marked_manual_at', now())
WHERE status = 'fresh'
  AND source NOT IN ('Yahoo Finance', 'MFAPI.in');

COMMIT;
