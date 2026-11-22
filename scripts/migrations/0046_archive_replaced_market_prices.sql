-- Archive the previous latest legacy price before it is replaced.
-- Keep the history row idempotent for retries of the same quote.
CREATE OR REPLACE FUNCTION wealth_archive_previous_market_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.unit_price IS DISTINCT FROM NEW.unit_price
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.source IS DISTINCT FROM NEW.source
     OR OLD.source_timestamp IS DISTINCT FROM NEW.source_timestamp THEN
    INSERT INTO wealth_price_history (
      asset_id, user_id, unit_price, currency, source,
      source_timestamp, recorded_at, metadata
    )
    SELECT
      OLD.asset_id, OLD.user_id, OLD.unit_price, OLD.currency, OLD.source,
      OLD.source_timestamp, now(),
      coalesce(OLD.metadata, '{}'::jsonb) || jsonb_build_object(
        'archived_from', 'wealth_market_prices',
        'archived_at', now(),
        'previous_fetched_at', OLD.fetched_at
      )
    WHERE NOT EXISTS (
      SELECT 1
      FROM wealth_price_history h
      WHERE h.asset_id = OLD.asset_id
        AND h.user_id = OLD.user_id
        AND h.unit_price = OLD.unit_price
        AND h.currency = OLD.currency
        AND h.source = OLD.source
        AND h.source_timestamp IS NOT DISTINCT FROM OLD.source_timestamp
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wealth_market_prices_archive_previous ON wealth_market_prices;
CREATE TRIGGER wealth_market_prices_archive_previous
BEFORE UPDATE ON wealth_market_prices
FOR EACH ROW
EXECUTE FUNCTION wealth_archive_previous_market_price();
