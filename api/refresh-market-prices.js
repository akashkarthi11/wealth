import {sql,json} from './_lib.js';

const YAHOO='https://query1.finance.yahoo.com/v8/finance/chart/';
const TROY_OUNCE_GRAMS=31.1034768;
async function mutualFundNav(asset){
 let schemeCode=String(asset.price_source_symbol||'');
 if(!/^\\d+$/.test(schemeCode)){
  const query=String(asset.price_source_symbol||asset.display_name||'').replace(/ - Direct Plan - Growth$/i,'');
  const search=await fetch('https://api.mfapi.in/mf/search?q='+encodeURIComponent(query),{signal:AbortSignal.timeout(8000)});
  if(!search.ok)throw new Error('MFAPI scheme search HTTP '+search.status);
  const matches=await search.json();
  const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const target=normalized(query);
  const match=(Array.isArray(matches)?matches:[]).find(x=>{
   const name=normalized(x.schemeName);
   return name.includes(target)&&name.includes('direct plan')&&name.includes('growth');
  })||(Array.isArray(matches)?matches:[]).find(x=>normalized(x.schemeName).includes(target));
  if(!match?.schemeCode)throw new Error('No matching Direct Growth mutual-fund scheme found for '+query);
  schemeCode=String(match.schemeCode);
  await sql.query("UPDATE wealth_investment_assets SET price_source_symbol=$2,updated_at=now() WHERE id=$1",[asset.id,schemeCode]);
 }
 const response=await fetch('https://api.mfapi.in/mf/'+encodeURIComponent(schemeCode)+'/latest',{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('MFAPI NAV HTTP '+response.status);
 const payload=await response.json();
 const nav=Number(payload?.data?.[0]?.nav);
 if(!Number.isFinite(nav)||nav<=0)throw new Error('No valid NAV for scheme '+schemeCode);
 const rawDate=String(payload.data[0].date||'');
 const parts=rawDate.split('-');
 const asOf=parts.length===3?new Date(Date.UTC(Number(parts[2]),Number(parts[1])-1,Number(parts[0]))):new Date();
 return {price:nav,asOf,currency:'INR',provider_symbol:schemeCode};
}
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
  const assets=await sql.query(`SELECT a.id,a.user_id,a.price_currency,a.price_source_symbol,a.quantity_unit,a.asset_class,a.display_name
    FROM wealth_investment_assets a WHERE a.pricing_status IN ('active','pending','stale')
    AND a.price_source_symbol IS NOT NULL`);
  const needsFx=assets.some(a=>a.price_currency==='USD'||a.price_source_symbol==='GC=F'||a.price_source_symbol==='SI=F');
  const fxPromise=needsFx?quote('INR=X'):Promise.resolve(null);
  const fx=await fxPromise;
  const results=await Promise.all(assets.map(async a=>{
   try{
    const q=a.asset_class==='indian_mutual_fund'?await mutualFundNav(a):await quote(a.price_source_symbol);
    let unitPrice=q.price;
    let asOf=q.asOf;
    if(a.price_source_symbol==='GC=F'||a.price_source_symbol==='SI=F'){
     if(!fx)throw new Error('USD/INR reference rate unavailable');
     unitPrice=q.price*fx.price/TROY_OUNCE_GRAMS;
     if(fx.asOf<asOf)asOf=fx.asOf;
    }
    const currency=a.price_currency||q.currency||'INR';
    await sql.query(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
      VALUES($1,$2,$3,$4,'Yahoo Finance',$5,now(),'fresh',$6::jsonb)
      ON CONFLICT(asset_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,currency=EXCLUDED.currency,
      source=EXCLUDED.source,source_timestamp=EXCLUDED.source_timestamp,fetched_at=now(),status='fresh',metadata=EXCLUDED.metadata`,
      [a.id,a.user_id,unitPrice,currency,asOf.toISOString(),JSON.stringify({provider_symbol:a.price_source_symbol,provider_currency:q.currency,unit:a.quantity_unit,pricing_basis:(a.price_source_symbol==='GC=F'||a.price_source_symbol==='SI=F')?'global futures parity converted from USD/oz to INR/g':'exchange quote',fx_to_inr:fx?.price||null})]);
    await sql.query(`INSERT INTO wealth_price_history(asset_id,user_id,unit_price,currency,source,source_timestamp,metadata)
      VALUES($1,$2,$3,$4,'Yahoo Finance',$5,$6::jsonb)`,
      [a.id,a.user_id,unitPrice,currency,asOf.toISOString(),JSON.stringify({provider_symbol:q.provider_symbol||a.price_source_symbol,unit:a.quantity_unit})]);
    await sql.query("UPDATE wealth_investment_assets SET pricing_status='active',updated_at=now() WHERE id=$1",[a.id]);
    return {asset_id:a.id,status:'updated',unit_price:unitPrice,currency};
   }catch(e){
    await sql.query("UPDATE wealth_market_prices SET status='stale' WHERE asset_id=$1",[a.id]).catch(()=>{});
    return {asset_id:a.id,status:'error',message:String(e?.message||e)};
   }
  }));
  return json(res,200,{updated:results.filter(x=>x.status==='updated').length,failed:results.filter(x=>x.status==='error').length,results});
 }catch(e){console.error('[market-price-refresh]',e?.message||e);return json(res,500,{error:'Market price refresh failed'})}
}
