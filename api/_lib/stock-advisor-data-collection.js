import { collectFincruxFinancials } from './stock-advisor-fincrux.js';
import { collectNseNewsBatch, cleanNseFeedItemMatches } from './stock-advisor-live-evidence.js';
export { cleanNseFeedItemMatches } from './stock-advisor-live-evidence.js';

const timeout=ms=>AbortSignal.timeout(ms);
async function collectMf({instrument,runId,db}){
 const scheme=String(instrument.price_source_symbol||instrument.symbol||'').trim();
 if(!/^\d{4,8}$/.test(scheme))return {ticker:instrument.symbol,status:'skipped',reason:'No saved AMFI scheme code'};
 const url='https://api.mfapi.in/mf/'+encodeURIComponent(scheme);
 const payload=await (await fetch(url,{headers:{Accept:'application/json'},signal:timeout(10000)})).json();
 const rows=(Array.isArray(payload?.data)?payload.data:[]).map(x=>{
  const p=String(x.date||'').split('-'),date=p.length===3?new Date(Date.UTC(+p[2],+p[1]-1,+p[0])):null,nav=Number(x.nav);
  return {date:date&&!Number.isNaN(date.getTime())?date.toISOString():null,nav};
 }).filter(x=>x.date&&Number.isFinite(x.nav)&&x.nav>0).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,5);
 if(!rows.length)throw new Error('MFAPI returned no valid dated NAV observations');
 const meta=payload.meta||{},title='Mutual fund NAV — '+String(meta.scheme_name||instrument.name||scheme);
 const evidence={provider:'MFAPI.in',scheme_code:scheme,scheme_name:meta.scheme_name||instrument.name||null,fund_house:meta.fund_house||null,scheme_type:meta.scheme_type||null,scheme_category:meta.scheme_category||null,observations:rows,currency:'INR',retrieved_at:new Date().toISOString(),verification_basis:'Valid dated NAV observations returned by MFAPI; scheme code taken from saved instrument pricing symbol.'};
 for(const observation of rows){
  await db.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price,fx_to_inr,fetched_at)
   VALUES($1,$2::timestamptz,'MFAPI.in',$3,NULL,now())
   ON CONFLICT(instrument_id,as_of,source) DO UPDATE SET price=EXCLUDED.price,fetched_at=now()`,
   [instrument.id,observation.date,observation.nav]);
 }
 await db.query(`INSERT INTO wealth_stock_advisor_research_sources(run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
  VALUES(NULL,$1,'fund_nav',$2,$3,'MFAPI.in',$4::timestamptz,now(),$5,$6::jsonb,'verified')
  ON CONFLICT(ticker,url) WHERE run_id IS NULL DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'`,
  [instrument.symbol,title,url,rows[0].date,'Latest NAV ₹'+rows[0].nav+' as of '+rows[0].date+'; '+rows.length+' dated NAV observations stored in wealth_instrument_prices.',JSON.stringify(evidence)]);
 return {ticker:instrument.symbol,status:'updated',source_type:'fund_nav',observations:rows.length,price_table:'wealth_instrument_prices'};
}
const TEJHQ_BASE='https://api.tejhq.dev/v1';
function technicalSnapshot(rows){
 const closes=rows.map(x=>Number(x.close)).filter(x=>Number.isFinite(x)&&x>0);
 if(closes.length<35)return null;
 const avg=n=>closes.slice(-n).reduce((a,b)=>a+b,0)/n;
 const changes=closes.slice(1).map((v,i)=>v-closes[i]);
 const last14=changes.slice(-14),gains=last14.filter(x=>x>0).reduce((a,b)=>a+b,0)/14,losses=-last14.filter(x=>x<0).reduce((a,b)=>a+b,0)/14;
 const rsi=losses===0?100:100-(100/(1+gains/losses));
 const ema=(values,period)=>values.reduce((acc,v,i)=>i===0?v:v*(2/(period+1))+acc*(1-2/(period+1)),values[0]);
 const macd=ema(closes.slice(-80),12)-ema(closes.slice(-80),26);
 const volume=rows.slice(-20).map(x=>Number(x.volume)||0),avgVolume=volume.reduce((a,b)=>a+b,0)/volume.length;
 return {rsi_14:Number(rsi.toFixed(2)),sma_20:Number(avg(20).toFixed(2)),sma_50:closes.length>=50?Number(avg(50).toFixed(2)):null,sma_200:closes.length>=200?Number(avg(200).toFixed(2)):null,macd_approx:Number(macd.toFixed(4)),latest_volume:Number(rows.at(-1)?.volume||0),average_volume_20d:Number(avgVolume.toFixed(0)),observations:closes.length};
}
async function collectTejHQEquity({instrument,db}){
 const symbol=String(instrument.symbol||'').toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9-&]{0,29}$/.test(symbol))return {ticker:symbol,status:'skipped',reason:'Invalid NSE symbol'};
 const to=new Date(),from=new Date(to.getTime()-420*86400000),iso=d=>d.toISOString().slice(0,10);
 const url=TEJHQ_BASE+'/ohlcv/nse/'+encodeURIComponent(symbol)+'?from='+iso(from)+'&to='+iso(to);
 const response=await fetch(url,{headers:{Accept:'application/json'},signal:timeout(12000)});
 if(!response.ok)throw new Error('TejHQ OHLCV HTTP '+response.status);
 const payload=await response.json(),rows=(Array.isArray(payload?.data)?payload.data:[])
  .filter(x=>/^\\d{4}-\\d{2}-\\d{2}$/.test(String(x.date||''))&&Number(x.close)>0)
  .sort((a,b)=>a.date.localeCompare(b.date)).slice(-260);
 if(rows.length<35)throw new Error('TejHQ returned insufficient OHLCV history ('+rows.length+' rows)');
 const priceRows=rows.map(row=>({as_of:new Date(row.date+'T15:30:00+05:30').toISOString(),price:Number(row.close)}));
 await db.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price,fx_to_inr,fetched_at)
  SELECT $1,(x->>'as_of')::timestamptz,'TejHQ',(x->>'price')::numeric,NULL,now()
  FROM jsonb_array_elements($2::jsonb) x
  ON CONFLICT(instrument_id,as_of,source) DO UPDATE SET price=EXCLUDED.price,fetched_at=now()`,
  [instrument.id,JSON.stringify(priceRows)]);
 const tech=technicalSnapshot(rows),latest=rows.at(-1),retrieved=new Date().toISOString();
 const evidence={provider:'TejHQ',endpoint:url,exchange:'NSE',symbol,price_basis:'end-of-day OHLCV close; not an intraday quote',latest_bar:latest,technical_indicators:tech,history_start:rows[0].date,history_end:latest.date,history_rows:rows.length,retrieved_at:retrieved,methodology:'RSI(14), SMA(20/50/200), approximate MACD(12/26), 20-session average volume calculated from TejHQ daily OHLCV.'};
 await db.query(`INSERT INTO wealth_stock_advisor_research_sources(run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
  VALUES(NULL,$1,'technical_indicator',$2,$3,'TejHQ',$4::timestamptz,now(),$5,$6::jsonb,'verified')
  ON CONFLICT(ticker,url) WHERE run_id IS NULL DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'`,
  [symbol,'Technical indicators — '+symbol,url,latest.date,JSON.stringify(tech),JSON.stringify(evidence)]);
 return {ticker:symbol,status:'updated',provider:'TejHQ',price_rows:rows.length,technical_indicators:tech,as_of:latest.date};
}

export async function runStockAdvisorDataCollection(db){
 const [run]=await db.query('INSERT INTO wealth_stock_advisor_data_collection_runs(status) VALUES(\'running\') RETURNING id');
 const summary={instruments:0,nav_updated:0,market_data_updated:0,financials_unverified:0,announcements:0,failed:0,skipped:0,feeds:0,results:[]};
 try{
  const instruments=await db.query(`SELECT DISTINCT i.id,i.asset_class,i.symbol,i.name,i.price_source_symbol
   FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
   WHERE h.status='active' AND i.symbol IS NOT NULL AND i.price_source_symbol IS NOT NULL
   ORDER BY i.symbol LIMIT 250`);
  summary.instruments=instruments.length;
  const funds=instruments.filter(i=>i.asset_class==='indian_mutual_fund');
  const equities=instruments.filter(i=>i.asset_class==='indian_equity');
  if(equities.length){
   const news=await collectNseNewsBatch({instruments:equities,db});
   summary.feeds=news.feeds_checked;
   summary.announcements=news.stored;
   summary.results.push({provider:news.provider,status:news.status,feeds_checked:news.feeds_checked,stored:news.stored,errors:news.errors});
   summary.results.push(...news.results);
   if(news.status==='unavailable')summary.failed++;
  }
  for(const instrument of funds){
   try{const r=await collectMf({instrument,runId:run.id,db});summary.results.push(r);if(r.status==='updated')summary.nav_updated++;else summary.skipped++}
   catch(e){summary.failed++;summary.results.push({ticker:instrument.symbol,status:'failed',error:String(e?.message||e).slice(0,180)})}
  }
  for(const instrument of equities){
   try{
    const market=await collectTejHQEquity({instrument,db});
    summary.results.push(market);
    if(market.status==='updated')summary.market_data_updated++;
   }catch(e){summary.failed++;summary.results.push({ticker:instrument.symbol,status:'market_data_failed',provider:'TejHQ',error:String(e?.message||e).slice(0,180)})}
   const rows=await collectEquityNews({instrument,runId:run.id,feeds,db});
   summary.results.push(...rows);summary.announcements+=rows.filter(x=>x.status==='stored_unverified').length;
   if(rows.some(x=>x.status==='feed_error'))summary.failed++;
  }
  if(String(process.env.FINCRUX_API_KEY||'').trim() && equities.length){
   const [quota]=await db.query(`SELECT count(*)::int AS used
    FROM wealth_stock_advisor_research_sources
    WHERE publisher='Fincrux'
      AND retrieved_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
      AND retrieved_at < ((date_trunc('day',now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata')`);
   const remaining=Math.max(0,5-Number(quota?.used||0));
   if(remaining){
    const recent=await db.query(`SELECT upper(ticker) AS ticker,max(retrieved_at) AS last_retrieved
      FROM wealth_stock_advisor_research_sources
      WHERE publisher='Fincrux' AND source_type='financial_statement'
      GROUP BY upper(ticker)`);
    const lastByTicker=new Map(recent.map(row=>[row.ticker,row.last_retrieved?Date.parse(row.last_retrieved):0]));
    const candidates=[...equities].sort((a,b)=>(lastByTicker.get(String(a.symbol).toUpperCase())||0)-(lastByTicker.get(String(b.symbol).toUpperCase())||0));
    for(const instrument of candidates.slice(0,remaining)){
     const financials=await collectFincruxFinancials({instrument,db});
     summary.results.push(financials);
     if(financials.status==='stored_unverified')summary.financials_unverified++;
     else if(financials.status==='failed')summary.failed++;
     else summary.skipped++;
    }
   }else summary.results.push({provider:'Fincrux',status:'skipped',reason:'Five free-tier requests already reserved today (IST).'});
  }else if(equities.length){
   summary.results.push({provider:'Fincrux',status:'skipped',reason:'FINCRUX_API_KEY is not configured; no paid or unauthenticated request attempted.'});
  }
  const successful=summary.nav_updated+summary.market_data_updated+summary.financials_unverified+summary.announcements;
  const status=summary.failed?(successful?'partial':'failed'):'succeeded';
  await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=$2,summary=$3::jsonb WHERE id=$1',[run.id,status,JSON.stringify(summary)]);
  return {run_id:run.id,status,...summary};
 }catch(error){
  await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=\'failed\',error=$2,summary=$3::jsonb WHERE id=$1',[run.id,String(error?.message||error).slice(0,500),JSON.stringify(summary)]).catch(()=>{});
  throw error;
 }
}
