import { sql, json, safeEqual, token } from '../_lib.js';
import { startJob, finishJob } from '../_jobs.js';
import debateHandler from '../_lib/stock-advisor-debate.js';

// Daily 04:18 UTC = 09:48 Asia/Kolkata. Vercel registers Cron only on Production;
// this same secured endpoint can be invoked manually on a Preview deployment for testing.
function nextRunAt(now=new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 18, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
async function runTicker(uid, sessionVersion, ticker) {
  const req = { method:'POST', route:'stock-advisor/free-run', url:'/api/stock-advisor/free-run',
    headers:{cookie:'wealth_session='+token(uid,sessionVersion)},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ticker,idempotency_key:'auto_'+ticker+'_'+new Date().toISOString().slice(0,10)})); } };
  const res = { statusCode:200, headers:{}, body:'', setHeader(k,v){this.headers[k]=v;}, end(v=''){this.body=String(v);return this;} };
  await debateHandler(req,res);
  let payload={};try{payload=JSON.parse(res.body||'{}')}catch{}
  if(res.statusCode<200||res.statusCode>=300||payload.saved!==true)throw new Error(String(payload.error||'Advisor pilot failed for '+ticker).slice(0,240));
  return {ticker,run_id:payload.run?.id||null,message_count:payload.messageCount||0,status:payload.run?.status==='completed'?'completed':'queued'};
}
async function mapLimit(items,limit,fn){
 const out=new Array(items.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i])}catch(e){out[i]={ticker:items[i],status:'failed',error:String(e?.message||e).slice(0,240)}}}}));
 return out;
}
export default async function handler(req,res){
 if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 const secret=String(process.env.CRON_SECRET||'').trim();
 if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
 if(!sql)return json(res,503,{error:'Database is not configured'});
 const job=await startJob('stock-advisor-auto-research');
 try{
  const users=await sql.query("SELECT s.user_id,s.mode,s.selected_tickers,u.session_version FROM wealth_stock_advisor_settings s JOIN wealth_users u ON u.id=s.user_id WHERE s.enabled=true AND (s.last_run_at IS NULL OR s.last_run_at < now() - interval '23 hours') ORDER BY s.updated_at");
  const summaries=[];let totalCompleted=0,totalQueued=0,totalFailed=0;
  for(const user of users){
   const selected=Array.isArray(user.selected_tickers)?user.selected_tickers:(typeof user.selected_tickers==='string'?JSON.parse(user.selected_tickers||'[]'):[]);
   const rows=user.mode==='manual'&&selected.length
    ?await sql.query("SELECT DISTINCT upper(ticker) AS ticker FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF') AND currency='INR' AND upper(ticker)=ANY($2::text[]) ORDER BY 1",[user.user_id,selected])
    :await sql.query("SELECT DISTINCT upper(ticker) AS ticker FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF') AND currency='INR' AND ticker IS NOT NULL ORDER BY 1",[user.user_id]);
   const tickers=rows.map(r=>String(r.ticker||'').trim().toUpperCase()).filter(Boolean).slice(0,30);
   if(!tickers.length){await sql.query("UPDATE wealth_stock_advisor_settings SET last_run_at=now(),next_run_at=$2,last_status='skipped',last_error='No eligible Indian equity or ETF holdings were found.',updated_at=now() WHERE user_id=$1",[user.user_id,nextRunAt()]);summaries.push({user_id:user.user_id,status:'skipped',reason:'No eligible Indian equity or ETF holdings'});continue;}
   await sql.query("UPDATE wealth_stock_advisor_settings SET last_run_at=now(),next_run_at=$2,last_status='running',last_error=NULL,updated_at=now() WHERE user_id=$1",[user.user_id,nextRunAt()]);
   const results=await mapLimit(tickers,3,ticker=>runTicker(user.user_id,Number(user.session_version||1),ticker));
   const completed=results.filter(r=>r.status==='completed').length,queued=results.filter(r=>r.status==='queued').length,failed=results.filter(r=>r.status==='failed').length;
   totalCompleted+=completed;totalQueued+=queued;totalFailed+=failed;
   const status=failed?(completed||queued?'partial':'failed'):queued?'running':'completed';
   const error=results.filter(r=>r.error).map(r=>r.ticker+': '+r.error).join(' | ').slice(0,1000)||null;
   await sql.query("UPDATE wealth_stock_advisor_settings SET last_status=$2,last_error=$3,next_run_at=$4,updated_at=now() WHERE user_id=$1",[user.user_id,status,error,nextRunAt()]);
   summaries.push({user_id:user.user_id,status,completed,failed,results});
  }
  const status=totalFailed?(totalCompleted||totalQueued?'partial':'failed'):'succeeded';
  await finishJob(job,status,{users:users.length,completed:totalCompleted,queued:totalQueued,failed:totalFailed});
  return json(res,200,{ok:totalFailed===0,scheduled_time:'09:48 Asia/Kolkata',users:summaries.length,completed:totalCompleted,queued:totalQueued,failed:totalFailed,limitations:['Debates are queued and processed as resumable one-message worker steps.','Evidence gaps force DATA REQUIRED; no unsupported market data is invented.','No orders or portfolio holdings are changed.'],results:summaries});
 }catch(e){await finishJob(job,'failed',{error:String(e?.message||e).slice(0,300)});console.error('[stock-advisor-scheduled]',e?.message||e);return json(res,500,{error:'Scheduled Auto Research failed.'});}
}
