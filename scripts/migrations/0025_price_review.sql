-- 0025: price review (owner, 2026-11-12). A wrong quote can be rejected from Data quality; the app then falls back to the
-- previous price. Additive and non-destructive: the rejected row is kept (who, when, why) and only skipped when the
-- latest price is read. Incident: TATSILV 3196.30 (about 18) and a fund quoted at 292.65 (NAV about 10.18) inflated the
-- v2 Angel One total by about Rs 3.5 lakh.
ALTER TABLE wealth_instrument_prices ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE wealth_instrument_prices ADD COLUMN IF NOT EXISTS rejected_by text;
ALTER TABLE wealth_instrument_prices ADD COLUMN IF NOT EXISTS rejected_reason text;

-- Same columns as before (dependent views keep working); rejected quotes are skipped.
CREATE OR REPLACE VIEW wealth_v_latest_prices AS
SELECT DISTINCT ON (instrument_id) instrument_id, as_of, source, price, fx_to_inr, fetched_at
FROM wealth_instrument_prices
WHERE rejected_at IS NULL
ORDER BY instrument_id, as_of DESC, fetched_at DESC;
