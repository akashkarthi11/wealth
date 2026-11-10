-- Convert Angel One mutual-fund screenshot aggregate into four unit-based positions.
-- Units come from the 31-Oct-2026 DP statement, while values are from the 10-Nov-2026 holdings snapshot.
INSERT INTO wealth_positions
 (user_id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,source_snapshot_id,source_key,metadata)
SELECT 'ddb0cf5a-8583-40c2-a5a7-4213a236ae1a'::uuid,'INVESTMENT','Angel One','Angel One','MUTUAL_FUND',v.name,NULL,'INR',v.units,v.current_value,v.invested_value,'2026-11-10T00:00:00Z',
 'a7ed763f-6406-4844-9dfc-7ae5165a1459'::uuid,'angelone-mf-holding-'||v.key,
 jsonb_build_object('plan','Direct Growth','scheme_name',v.scheme_name,'nav_source','MFAPI.in','quantity_source','Angel One DP statement 2026-10-31','valuation_source','Angel One MF snapshot 2026-11-10')
FROM (VALUES
 ('nippon-large-cap','Nippon India Large Cap Fund','Nippon India Large Cap Fund - Direct Plan - Growth',29.020::numeric,7202::numeric,7000::numeric),
 ('motilal-flexi-cap','Motilal Oswal Flexi Cap Fund','Motilal Oswal Flexi Cap Fund - Direct Plan - Growth',59.600::numeric,4277::numeric,3999::numeric),
 ('icici-nifty-auto','ICICI Prudential Nifty Auto Index Fund','ICICI Prudential Nifty Auto Index Fund - Direct Plan - Growth',54.774::numeric,1237::numeric,1213::numeric),
 ('jioblackrock-flexi-cap','JioBlackRock Flexi Cap Fund','JioBlackRock Flexi Cap Fund - Direct Plan - Growth',50.708::numeric,510::numeric,500::numeric)
) AS v(key,name,scheme_name,units,current_value,invested_value)
WHERE NOT EXISTS (SELECT 1 FROM wealth_positions p WHERE p.user_id='ddb0cf5a-8583-40c2-a5a7-4213a236ae1a' AND p.source_key='angelone-mf-holding-'||v.key);

INSERT INTO wealth_investment_assets
 (user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
SELECT p.user_id,p.id,'indian_mutual_fund',p.source_key,p.name,'unit','INR','MFAPI.in',
 p.metadata->>'scheme_name','pending'
FROM wealth_positions p
WHERE p.user_id='ddb0cf5a-8583-40c2-a5a7-4213a236ae1a'
 AND p.source_key LIKE 'angelone-mf-holding-%'
ON CONFLICT(position_id) DO UPDATE SET
 asset_class=EXCLUDED.asset_class,symbol=EXCLUDED.symbol,display_name=EXCLUDED.display_name,
 quantity_unit=EXCLUDED.quantity_unit,price_currency=EXCLUDED.price_currency,
 price_source=EXCLUDED.price_source,price_source_symbol=EXCLUDED.price_source_symbol,
 pricing_status='pending',updated_at=now();

-- Seed initial NAV from latest screenshot values / units; scheduled NAV refresh will replace it.
INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
SELECT a.id,p.user_id,p.current_value/NULLIF(p.quantity,0),'INR','Angel One initial NAV',
 '2026-11-10T00:00:00Z',now(),'fresh',jsonb_build_object('seeded_from_snapshot',true,'scheme_name',a.price_source_symbol)
FROM wealth_positions p JOIN wealth_investment_assets a ON a.position_id=p.id
WHERE p.user_id='ddb0cf5a-8583-40c2-a5a7-4213a236ae1a'
 AND p.source_key LIKE 'angelone-mf-holding-%'
ON CONFLICT(asset_id) DO NOTHING;

UPDATE wealth_positions SET record_type='MUTUAL_FUND_AGGREGATE_ARCHIVED',
 metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('archived',true,'reason','Replaced by individual mutual-fund scheme positions','archived_at','2026-11-10')
WHERE user_id='ddb0cf5a-8583-40c2-a5a7-4213a236ae1a' AND record_type='MUTUAL_FUND' AND name='Angel One mutual funds aggregate';

UPDATE wealth_positions SET record_type='US_PORTFOLIO_AGGREGATE_ARCHIVED',
 metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('archived',true,'reason','Underlying US stock and ETF positions are stored individually','archived_at','2026-11-10')
WHERE user_id='ddb0cf5a-8583-40c2-a5a7-4213a236ae1a' AND record_type='US_PORTFOLIO_INR';
