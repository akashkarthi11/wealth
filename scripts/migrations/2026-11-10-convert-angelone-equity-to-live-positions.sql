-- Convert the latest Angel One equity holdings snapshot into first-class portfolio positions.
-- The aggregate row is retained as an archived audit record and excluded from live wealth totals.
WITH latest_snapshot AS (
 SELECT id,user_id,source_key,snapshot_date,payload
 FROM wealth_snapshots
 WHERE source_key LIKE 'angelone-equity-holdings-%'
 ORDER BY snapshot_date DESC,created_at DESC
 LIMIT 1
), holdings AS (
 SELECT s.id AS snapshot_id,s.user_id,s.source_key,s.snapshot_date,
        h->>'symbol' AS symbol,
        (h->>'quantity')::numeric AS quantity,
        (h->>'average_price')::numeric AS average_price,
        (h->>'last_traded_price')::numeric AS ltp,
        h AS raw_holding
 FROM latest_snapshot s
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'holdings','[]'::jsonb)) h
 WHERE COALESCE(h->>'status','active')='active'
   AND NULLIF(h->>'symbol','') IS NOT NULL
   AND (h->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
   AND (h->>'average_price') ~ '^[0-9]+(\.[0-9]+)?$'
   AND (h->>'last_traded_price') ~ '^[0-9]+(\.[0-9]+)?$'
   AND (h->>'quantity')::numeric>0
   AND (h->>'last_traded_price')::numeric>0
), inserted AS (
 INSERT INTO wealth_positions
  (user_id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,source_snapshot_id,source_key,metadata)
 SELECT h.user_id,'INVESTMENT','Angel One','Angel One','EQUITY',h.symbol,h.symbol,'INR',
        h.quantity,h.quantity*h.ltp,h.quantity*h.average_price,
        (h.snapshot_date::timestamp AT TIME ZONE 'UTC'),h.snapshot_id,
        'angelone-equity-holding-'||h.symbol,
        jsonb_build_object('source','Angel One holdings snapshot','snapshot_id',h.snapshot_id,
          'average_price',h.average_price,'last_traded_price',h.ltp,'original_holding',h.raw_holding)
 FROM holdings h
 WHERE NOT EXISTS (
  SELECT 1 FROM wealth_positions p
  WHERE p.user_id=h.user_id AND p.source_key='angelone-equity-holding-'||h.symbol
 )
 RETURNING id,user_id,ticker,quantity,current_value
)
SELECT count(*) FROM inserted;

-- Attach the existing history-only trackers to the newly created real portfolio positions.
UPDATE wealth_investment_assets a
SET position_id=p.id,quantity_unit='share',price_currency='INR',
    price_source='Yahoo Finance',price_source_symbol=p.ticker||'.NS',
    pricing_status='active',updated_at=now()
FROM wealth_positions p
WHERE a.position_id IS NULL
  AND a.user_id=p.user_id
  AND a.symbol=p.ticker
  AND p.source_key='angelone-equity-holding-'||p.ticker;

-- Seed the latest-price table from the most recent broker snapshot so valuation is immediately available.
-- The normal market refresh replaces this quote with the provider's latest exchange price.
INSERT INTO wealth_market_prices
 (asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
SELECT a.id,p.user_id,
       (p.metadata->>'last_traded_price')::numeric,'INR',
       'Angel One initial LTP',
       p.balance_as_of,now(),'fresh',
       jsonb_build_object('provider_symbol',a.price_source_symbol,'seeded_from_snapshot',p.source_snapshot_id)
FROM wealth_positions p
JOIN wealth_investment_assets a ON a.position_id=p.id
WHERE p.source_key LIKE 'angelone-equity-holding-%'
  AND NULLIF(p.metadata->>'last_traded_price','') IS NOT NULL
ON CONFLICT(asset_id) DO UPDATE SET
 unit_price=EXCLUDED.unit_price,currency=EXCLUDED.currency,source=EXCLUDED.source,
 source_timestamp=EXCLUDED.source_timestamp,fetched_at=now(),status='fresh',metadata=EXCLUDED.metadata;

-- Preserve the old aggregate for audit, but remove it from all live investment totals.
UPDATE wealth_positions
SET category='ARCHIVED',
    metadata=metadata||jsonb_build_object('archived_reason','Replaced by individual Angel One equity positions',
      'archived_at',now(),'replacement_snapshot_id',(
       SELECT id FROM wealth_snapshots WHERE source_key LIKE 'angelone-equity-holdings-%'
       ORDER BY snapshot_date DESC,created_at DESC LIMIT 1
      )),
    updated_at=now()
WHERE user_id=(SELECT id FROM wealth_users WHERE role='admin' ORDER BY created_at LIMIT 1)
  AND id='ab2f7b47-5237-4050-be10-528dd590c963'
  AND category<>'ARCHIVED';
