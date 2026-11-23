import { sql,json,safeEqual } from '../_lib.js';
import { startJob,finishJob } from '../_jobs.js';
import { runStockAdvisorDataCollection } from '../_lib/stock-advisor-data-collection.js';

export default async function handler(req,res){
 if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 const secret=String(process.env.CRON_SECRET||'').trim();
 if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
 if(!sql)return json(res,503,{error:'Database is not configured'});
 const job=await startJob('stock-advisor-data-collection');
 try{
  const result=await runStockAdvisorDataCollection(sql);
  await finishJob(job,result.status,{run_id:result.run_id,instruments:result.instruments,nav_updated:result.nav_updated,market_data_updated:result.market_data_updated,financials_unverified:result.financials_unverified,announcements:result.announcements,failed:result.failed,skipped:result.skipped,feeds:result.feeds});
  return json(res,200,{ok:result.status==='succeeded',schedule:'daily 18:30 Asia/Kolkata',...result,
   limitations:['NSE RSS entries are stored as unverified listings until linked filing contents are fetched and validated.','Optional Fincrux financial snapshots are limited to five requests per IST day and remain unverified until corroborated against official filings.','General business-news feeds and automatic filing-document extraction are not included.','Only active instruments with saved price-source symbols are processed.']});
 }catch(error){
  await finishJob(job,'failed',{error:String(error?.message||error).slice(0,300)});
  console.error('[stock-advisor-data-collection]',error?.message||error);
  return json(res,500,{error:'Stock Advisor data collection failed.'});
 }
}
