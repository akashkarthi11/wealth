import {sql,json,invalidateUserCaches} from './_lib.js';

// Daily price refresh (Vercel Cron). Writes:
//   v1: wealth_market_prices / wealth_price_history per legacy asset (kept while v1 is live)
//   v2: wealth_instrument_prices once per instrument, with fx_to_inr for USD (TSD TR-5.4)
// A failed quote never writes 'fresh': v1 marks the row stale, v2 writes nothing (last price ages out).

const YAHOO='https://query1.finance.yahoo.com/v8/finance/chart/';
const TROY_OUNCE_GRAMS=31.1034768;
const METAL_FUTURES=new Set(['GC=F','SI=F']);

async function yahooQuote(symbol){
 const r=await fetch(YAHOO+encodeURIComponent(symbol)+'?range=1d&interval=5m',{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw new Error('Quote provider HTTP '+r.status);
 const j=await r.json();
 const result=j?.chart?.result?.[0];
 const price=Number(result?.meta?.regularMarketPrice);
 if(!Number.isFinite(price)||price<=0)throw new Error('No valid quote for '+symbol);
 return {price,asOf:result.meta.regularMarketTime?new Date(result.meta.regularMarketTime*1000):new Date(),currency:result.meta.currency||null};
}

// Resolve an AMFI scheme code once (by name), then read the latest NAV.
async function mutualFundNav(symbolOrName,displayName){
 let schemeCode=String(symbolOrName||'');
 let resolved=false;
 if(!/^[0-9]+$/.test(schemeCode)){
  const query=String(symbolOrName||displayName||'').replace(/ - Direct Plan - Growth$/i,'');
  const search=await fetch('https://api.mfapi.in/mf/search?q='+encodeURIComponent(query),{signal:AbortSignal.timeout(8000)});
  if(!search.ok)throw new Error('MFAPI scheme search HTTP '+search.status);
  const matches=await search.json();
  const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const target=normalized(query);
  const list=Array.isArray(matches)?matches:[];
  const match=list.find(x=>{const n=normalized(x.schemeName);return n.includes(target)&&n.includes('direct plan')&&n.includes('growth')})||list.find(x=>normalized(x.schemeName).includes(target));
  if(!match?.schemeCode)throw new Error('No matching Direct Growth mutual-fund scheme found for '+query);
  schemeCode=String(match.schemeCode);resolved=true;
 }
 const response=await fetch('https://api.mfapi.in/mf/'+encodeURIComponent(schemeCode)+'/latest',{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('MFAPI NAV HTTP '+response.status);
 const payload=await response.json();
 const nav=Number(payload?.data?.[0]?.nav);
 if(!Number.isFinite(nav)||nav<=0)throw new Error('No valid NAV for scheme '+schemeCode);
 const parts=String(payload.data[0].date||'').split('-');
 const asOf=parts.length===3?new Date(Date.UTC(Number(parts[2]),Number(parts[1])-1,Number(parts[0]))):new Date();
 return {price:nav,asOf,currency:'INR',schemeCode,resolved};
}

// One quote per (class, symbol) per run, shared by v1 and v2.
export function makePricer(fx){
 const memo=new Map();
 return function price({assetClass,symbol,name,currency}){
  const key=assetClass+'|'+symbol;
  if(!memo.has(key))memo.set(key,(async()=>{
   if(assetClass==='indian_mutual_fund'){
    const q=await mutualFundNav(symbol,name);
    return {unitPrice:q.price,asOf:q.asOf,currency:'INR',providerSymbol:q.schemeCode,resolvedSymbol:q.resolved?q.schemeCode:null,source:'MFAPI.in',basis:'AMFI mutual fund NAV',fx:null};
   }
   const q=await yahooQuote(symbol);
   if(METAL_FUTURES.has(symbol)){
    if(!fx)throw new Error('USD/INR reference rate unavailable');
    return {unitPrice:q.price*fx.price/TROY_OUNCE_GRAMS,asOf:fx.asOf<q.asOf?fx.asOf:q.asOf,currency:'INR',providerSymbol:symbol,source:'Yahoo Finance',basis:'global futures parity converted from USD/oz to INR/g',fx};
   }
   if((currency||q.currency)==='USD'&&!fx)throw new Error('USD/INR reference rate unavailable; USD valuation was not refreshed');
   return {unitPrice:q.price,asOf:q.asOf,currency:currency||q.currency||'INR',providerSymbol:symbol,source:'Yahoo Finance',basis:'exchange quote',fx};
  })());
  return memo.get(key);
 };
}

async function refreshLegacy(price){
 const assets=await sql.query(`SELECT a.id,a.user_id,a.price_currency,a.price_source_symbol,a.quantity_unit,a.asset_class,a.display_name
   FROM wealth_investment_assets a WHERE a.pricing_status IN ('active','pending','stale') AND a.price_source_symbol IS NOT NULL`);
 const users=new Set();
 const results=await Promise.all(assets.map(async a=>{
  try{
   const q=await price({assetClass:a.asset_class,symbol:a.price_source_symbol,name:a.display_name,currency:String(a.price_currency||'').trim()||null});
   if(q.resolvedSymbol)await sql.query('UPDATE wealth_investment_assets SET price_source_symbol=$2,updated_at=now() WHERE id=$1',[a.id,q.resolvedSymbol]);
   const meta={provider_symbol:q.providerSymbol,unit:a.quantity_unit,pricing_basis:q.basis,fx_to_inr:q.fx?.price||null,fx_as_of:q.fx?.asOf?.toISOString()||null};
   await sql.query(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
     VALUES($1,$2,$3,$4,$7,$5,now(),'fresh',$6::jsonb)
     ON CONFLICT(asset_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,currency=EXCLUDED.currency,source=EXCLUDED.source,
     source_timestamp=EXCLUDED.source_timestamp,fetched_at=now(),status='fresh',metadata=EXCLUDED.metadata`,
     [a.id,a.user_id,q.unitPrice,q.currency,q.asOf.toISOString(),JSON.stringify(meta),q.source]);
   await sql.query(`INSERT INTO wealth_price_history(asset_id,user_id,unit_price,currency,source,source_timestamp,metadata) VALUES($1,$2,$3,$4,$6,$5,$7::jsonb)`,
     [a.id,a.user_id,q.unitPrice,q.currency,q.asOf.toISOString(),q.source,JSON.stringify(meta)]);
   await sql.query("UPDATE wealth_investment_assets SET pricing_status='active',updated_at=now() WHERE id=$1",[a.id]);
   users.add(a.user_id);
   return {asset_id:a.id,status:'updated',unit_price:q.unitPrice,currency:q.currency};
  }catch(e){
   await sql.query("UPDATE wealth_market_prices SET status='stale' WHERE asset_id=$1",[a.id]).catch(()=>{});
   return {asset_id:a.id,status:'error',message:String(e?.message||e)};
  }
 }));
 return {results,users};
}

async function refreshInstruments(price){
 let instruments;
 try{
  instruments=await sql.query(`SELECT i.id,i.asset_class,i.symbol,i.name,trim(i.currency) AS currency,i.price_source_symbol
    FROM wealth_instruments i WHERE i.price_source_symbol IS NOT NULL AND EXISTS (SELECT 1 FROM wealth_holdings h WHERE h.instrument_id=i.id)`);
 }catch(e){
  if(e?.code==='42P01')return {results:[],skipped:'account hierarchy not migrated'};
  throw e;
 }
 const results=await Promise.all(instruments.map(async i=>{
  try{
   const q=await price({assetClass:i.asset_class,symbol:i.price_source_symbol,name:i.name,currency:i.currency});
   if(q.resolvedSymbol)await sql.query('UPDATE wealth_instruments SET price_source_symbol=$2 WHERE id=$1',[i.id,q.resolvedSymbol]);
   if(i.currency==='USD'&&!(q.fx?.price>0))throw new Error('USD price without USD/INR rate not stored');
   await sql.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price,fx_to_inr,fetched_at)
     VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT (instrument_id,as_of,source) DO NOTHING`,
     [i.id,q.asOf.toISOString(),q.source,q.unitPrice,i.currency==='USD'?q.fx.price:null]);
   return {instrument_id:i.id,symbol:i.symbol,status:'updated',price:q.unitPrice,currency:i.currency};
  }catch(e){return {instrument_id:i.id,symbol:i.symbol,status:'error',message:String(e?.message||e)}}
 }));
 return {results};
}

export default async function handler(req,res){
 try{
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=process.env.CRON_SECRET;
  if(!secret||req.headers.authorization!=='Bearer '+secret)return json(res,401,{error:'Unauthorized'});
  if(!sql)throw new Error('Database is not configured');
  const fx=await yahooQuote('INR=X').catch(e=>{console.warn('[market-price-refresh:fx]',e?.message||e);return null});
  const price=makePricer(fx);
  const legacy=await refreshLegacy(price);
  const v2=await refreshInstruments(price);
  const retention=await pruneAdvisorReports().catch(e=>({error:String(e?.message||e)}));
  // v2 prices are shared, so every user's cached views may change.
  const affected=new Set(legacy.users);
  if(v2.results.some(r=>r.status==='updated'))(await sql.query('SELECT id FROM wealth_users')).forEach(u=>affected.add(u.id));
  await Promise.all([...affected].map(uid=>invalidateUserCaches(uid)));
  const count=(rs,s)=>rs.filter(x=>x.status===s).length;
  return json(res,200,{
   fx:fx?{rate:fx.price,asOf:fx.asOf.toISOString()}:null,
   updated:count(legacy.results,'updated'),failed:count(legacy.results,'error'),results:legacy.results,
   instruments:{updated:count(v2.results,'updated'),failed:count(v2.results,'error'),skipped:v2.skipped||null,results:v2.results},
   retention,
  });
 }catch(e){console.error('[market-price-refresh]',e?.message||e);return json(res,500,{error:'Market price refresh failed'})}
}

// Stock Advisor retention (TSD TR-6.5): keep every report for N days, then the latest per day.
// Disabled unless WEALTH_ADVISOR_RETENTION_DAYS is set (it deletes rows).
async function pruneAdvisorReports(){
 const days=Number(process.env.WEALTH_ADVISOR_RETENTION_DAYS||0);
 if(!(days>=7))return {enabled:false};
 const rows=await sql.query(`DELETE FROM wealth_stock_advisor_reports r
   WHERE r.run_at < now() - make_interval(days => $1)
     AND EXISTS (SELECT 1 FROM wealth_stock_advisor_reports k
                 WHERE k.user_id=r.user_id AND date_trunc('day',k.run_at)=date_trunc('day',r.run_at) AND k.run_at>r.run_at)
   RETURNING r.id`,[days]);
 return {enabled:true,keepDays:days,deleted:rows.length};
}
