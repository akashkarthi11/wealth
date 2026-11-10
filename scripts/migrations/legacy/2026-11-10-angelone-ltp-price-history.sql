-- Backfill historical Angel One Indian-equity LTP observations into the unified price history.
-- History-only assets have no linked wealth_positions row, so they cannot affect net-worth totals.
ALTER TABLE wealth_investment_assets ALTER COLUMN position_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wealth_investment_assets_history_symbol_uidx
 ON wealth_investment_assets(user_id,symbol)
 WHERE position_id IS NULL;

INSERT INTO wealth_investment_assets
 (user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
SELECT DISTINCT s.user_id,NULL::uuid,'indian_equity',trim(h->>'symbol'),trim(h->>'symbol'),'share','INR',
 'Yahoo Finance',trim(h->>'symbol')||'.NS', 'active'
FROM wealth_snapshots s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'holdings','[]'::jsonb)) h
WHERE s.source_key LIKE 'angelone-equity-holdings-%'
 AND trim(COALESCE(h->>'symbol',''))<>''
 AND COALESCE(h->>'status','active')<>'inactive'
 AND jsonb_typeof(h->'last_traded_price')='number'
 AND (h->>'last_traded_price')::numeric>0
 AND NOT EXISTS (
  SELECT 1 FROM wealth_investment_assets existing
  WHERE existing.user_id=s.user_id AND existing.symbol=trim(h->>'symbol')
    AND existing.position_id IS NOT NULL
 )
ON CONFLICT (user_id,symbol) WHERE position_id IS NULL
DO UPDATE SET display_name=EXCLUDED.display_name,asset_class=EXCLUDED.asset_class,
 quantity_unit=EXCLUDED.quantity_unit,price_currency=EXCLUDED.price_currency,
 price_source=EXCLUDED.price_source,price_source_symbol=EXCLUDED.price_source_symbol,pricing_status='active',updated_at=now();

INSERT INTO wealth_price_history
 (asset_id,user_id,unit_price,currency,source,source_timestamp,metadata)
SELECT a.id,s.user_id,(h->>'last_traded_price')::numeric,'INR',
 'Angel One historical snapshot',
 ((s.snapshot_date::timestamp + interval '12 hours') AT TIME ZONE 'Asia/Kolkata'),
 jsonb_build_object(
  'symbol',trim(h->>'symbol'),
  'snapshot_date',s.snapshot_date,
  'snapshot_id',s.id,
  'source_key',s.source_key,
  'source_name',s.source_name,
  'quantity',NULLIF(h->>'quantity','')::numeric,
  'average_price',NULLIF(h->>'average_price','')::numeric,
  'unrealized_pnl',NULLIF(h->>'unrealized_pnl','')::numeric,
  'return_pct',NULLIF(h->>'return_pct','')::numeric,
  'holding_status',COALESCE(h->>'status','active'),
  'timestamp_precision','date-only',
  'original_holding',h
 )
FROM wealth_snapshots s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'holdings','[]'::jsonb)) h
JOIN wealth_investment_assets a
 ON a.user_id=s.user_id AND a.symbol=trim(h->>'symbol') AND a.position_id IS NULL
WHERE s.source_key LIKE 'angelone-equity-holdings-%'
 AND trim(COALESCE(h->>'symbol',''))<>''
 AND COALESCE(h->>'status','active')<>'inactive'
 AND jsonb_typeof(h->'last_traded_price')='number'
 AND (h->>'last_traded_price')::numeric>0
 AND NOT EXISTS (
  SELECT 1 FROM wealth_price_history existing
  WHERE existing.asset_id=a.id
   AND existing.source='Angel One historical snapshot'
   AND existing.metadata->>'snapshot_id'=s.id::text
 );

CREATE INDEX IF NOT EXISTS wealth_price_history_source_time_idx
 ON wealth_price_history(user_id,source_timestamp DESC);
