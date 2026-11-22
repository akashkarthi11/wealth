import { collectFincruxFinancials } from './stock-advisor-fincrux.js';
import { collectNseNewsBatch } from './stock-advisor-live-evidence.js';
import { collectMutualFundEvidence } from './stock-advisor-mfapi.js';
import { collectTejHqEquityEvidence } from './stock-advisor-tejhq.js';
export { cleanNseFeedItemMatches } from './stock-advisor-live-evidence.js';

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
   try{
    const r=await collectMutualFundEvidence({ticker:instrument.symbol,name:instrument.name,schemeCode:instrument.price_source_symbol,instrumentId:instrument.id,runId:null,db});
    summary.results.push(r);
    if(r.status==='ok')summary.nav_updated++;else if(r.status==='unavailable')summary.failed++;else summary.skipped++;
   }catch(e){summary.failed++;summary.results.push({ticker:instrument.symbol,status:'failed',provider:'MFAPI.in',error:String(e?.message||e).slice(0,180)})}
  }
  for(const instrument of equities){
   try{
    const market=await collectTejHqEquityEvidence({ticker:instrument.symbol,name:instrument.name,db});
    summary.results.push(market);
    if(market.status==='ok')summary.market_data_updated++;
   }catch(e){summary.failed++;summary.results.push({ticker:instrument.symbol,status:'market_data_failed',provider:'TejHQ',error:String(e?.message||e).slice(0,180)})}
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
