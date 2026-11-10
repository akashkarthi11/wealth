import {sql,json} from './_lib.js';

const YAHOO='https://query1.finance.yahoo.com/v8/finance/chart/';
const TROY_OUNCE_GRAMS=31.1034768;
async function quote(symbol){
 const url=YAHOO+encodeURIComponent(symbol)+'?range=1d&interval=5m';
 const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw new Error('Quote provider HTTP '+r.status);
 const j=await r.json();
 const result=j?.chart?.result?.[0];
 const price=Number(result?.meta?.regularMarketPrice);
 if(!Number.isFinite(price)||price<=0)throw new Error('No valid quote for '+symbol);
 return {price,asOf:result.meta.regularMarketTime?new Date(result.meta.regularMarketTime*1000):new Date(),currency:result.meta.currency||null};
}
export default async function handler(req,res){
 try{
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=process.env.CRON_SECRET;
  if(!secret||req.headers.authorization!=='Bearer '+secret)return json(res,401,{error:'Unauthorized'});
  if(!sql)throw new Error('Database is not configured');
  const assets=await sql.query(`SELECT a.id,a.user_id,a.price_currency,a.price_source_symbol,a.quantity_unit
    FROM wealth_investment_assets a WHERE a.pricing_status IN ('active','pending','stale')
    AND a.price_source_symbol IS NOT NULL`);
  const results=[];
  for(const a of assets){
   try{
    const q=await quote(a.price_source_symbol);
    let unitPrice=q.price;
    let asOf=q.asOf;
    // Gold and silver futures are quoted in USD per troy ounce; convert to INR per gram.
    if(a.price_source_symbol==='GC=F'||a.price_source_symbol==='SI=F'){
     const fx=await quote('INR=X');
     unitPrice=q.price*fx.price/TROY_OUNCE_GRAMS;
     if(fx.asOf<asOf)asOf=fx.asOf;
    }
    const currency=a.price_currency||q.currency||'INR';
    await sql.query(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
      VALUES($1,$2,$3,$4,'Yahoo Finance',$5,now(),'fresh',$6::jsonb)
      ON CONFLICT(asset_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,currency=EXCLUDED.currency,
      source=EXCLUDED.source,source_timestamp=EXCLUDED.source_timestamp,fetched_at=now(),status='fresh',metadata=EXCLUDED.metadata`,
      [a.id,a.user_id,unitPrice,currency,asOf.toISOString(),JSON.stringify({provider_symbol:a.price_source_symbol,provider_currency:q.currency,unit:a.quantity_unit,pricing_basis:(a.price_source_symbol==='GC=F'||a.price_source_symbol==='SI=F')?'global futures parity converted from USD/oz to INR/g':'exchange quote'})]);
    await sql.query(`INSERT INTO wealth_price_history(asset_id,user_id,unit_price,currency,source,source_timestamp,metadata)
      VALUES($1,$2,$3,$4,'Yahoo Finance',$5,$6::jsonb)`,
      [a.id,a.user_id,unitPrice,currency,asOf.toISOString(),JSON.stringify({provider_symbol:a.price_source_symbol,unit:a.quantity_unit})]);
    await sql.query("UPDATE wealth_investment_assets SET pricing_status='active',updated_at=now() WHERE id=$1",[a.id]);
    results.push({asset_id:a.id,status:'updated',unit_price:unitPrice,currency});
   }catch(e){
    await sql.query("UPDATE wealth_market_prices SET status='stale' WHERE asset_id=$1",[a.id]).catch(()=>{});
    results.push({asset_id:a.id,status:'error',message:String(e?.message||e)});
   }
  }
  return json(res,200,{updated:results.filter(x=>x.status==='updated').length,failed:results.filter(x=>x.status==='error').length,results});
 }catch(e){console.error('[market-price-refresh]',e?.message||e);return json(res,500,{error:'Market price refresh failed'})}
}
