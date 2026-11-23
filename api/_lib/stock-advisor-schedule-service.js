import { sql, token } from '../_lib.js';
import debateHandler from './stock-advisor-debate.js';
import {
  SCHEDULE_TIMEZONE, DEFAULT_SCHEDULE_TIME, nextScheduledAt,
  dueScheduleDates, zonedDateTimeToUtc, getLocalDateTime
} from './stock-advisor-schedule-time.js';

async function mapLimit(items,limit,fn) {
  const out=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i]);}catch(error){out[i]={ticker:items[i],status:'failed',error:String(error?.message||error).slice(0,240)};}}
  }));
  return out;
}
async function tickersForUser(uid,settings) {
  const selected=Array.isArray(settings.selected_tickers)?settings.selected_tickers:(typeof settings.selected_tickers==='string'?JSON.parse(settings.selected_tickers||'[]'):[]);
  const rows=settings.mode==='manual'&&selected.length
    ?await sql.query("SELECT DISTINCT upper(ticker) AS ticker FROM wealth_positions WHERE user_id=$1::uuid AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF') AND currency='INR' AND upper(ticker)=ANY($2::text[]) ORDER BY 1",[uid,selected])
    :await sql.query("SELECT DISTINCT upper(ticker) AS ticker FROM wealth_positions WHERE user_id=$1::uuid AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF') AND currency='INR' AND ticker IS NOT NULL ORDER BY 1",[uid]);
  return rows.map(r=>String(r.ticker||'').trim().toUpperCase()).filter(Boolean).slice(0,30);
}
async function runTicker(uid,sessionVersion,ticker,idempotencyKey,executionId) {
  const req={
    method:'POST',route:'stock-advisor/free-run',url:'/api/stock-advisor/free-run',
    headers:{cookie:'wealth_session='+token(uid,sessionVersion)},
    async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({ticker,idempotency_key:idempotencyKey,schedule_execution_id:executionId}));}
  };
  const res={statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(v=''){this.body=String(v);return this;}};
  await debateHandler(req,res);
  let payload={};try{payload=JSON.parse(res.body||'{}')}catch{}
  if(res.statusCode<200||res.statusCode>=300||payload.saved!==true)throw new Error(String(payload.error||'Advisor research could not be queued for '+ticker).slice(0,240));
  return {ticker,run_id:payload.run?.id||null,message_count:payload.messageCount||0,status:payload.run?.status==='completed'?'completed':'queued'};
}
export async function executeUserResearch({uid,sessionVersion,settings,executionId,executionKey,runType='manual',scheduledDate=null,now=new Date()}) {
  await sql.query("UPDATE wealth_stock_advisor_schedule_runs SET status='running',started_at=COALESCE(started_at,now()),attempt_count=attempt_count+1,updated_at=now() WHERE id=$1 AND user_id=$2::uuid",[executionId,uid]);
  try {
    const tickers=await tickersForUser(uid,settings);
    if(!tickers.length) {
      await sql.query("UPDATE wealth_stock_advisor_schedule_runs SET status='skipped',finished_at=now(),last_error='No eligible Indian equity or ETF holdings were found.',updated_at=now() WHERE id=$1",[executionId]);
      if(runType==='scheduled')await sql.query("UPDATE wealth_stock_advisor_settings SET last_run_at=now(),last_scheduled_date=$2,last_status='skipped',last_error='No eligible Indian equity or ETF holdings were found.',next_run_at=$3,updated_at=now() WHERE user_id=$1::uuid",[uid,scheduledDate,nextScheduledAt(now,settings.schedule_time||DEFAULT_SCHEDULE_TIME,settings.schedule_frequency||'daily',SCHEDULE_TIMEZONE).toISOString()]);
      return {status:'skipped',tickers:0,results:[]};
    }
    const localDate=scheduledDate||getLocalDateTime(now,SCHEDULE_TIMEZONE).date;
    const results=await mapLimit(tickers,3,ticker=>runTicker(uid,sessionVersion,ticker,(runType==='scheduled'?'auto_':'manual_')+ticker+'_'+(runType==='scheduled'?localDate:executionKey.replace(/[^a-zA-Z0-9_-]/g,'_')),executionId));
    const completed=results.filter(r=>r.status==='completed').length;
    const queued=results.filter(r=>r.status==='queued').length;
    const failed=results.filter(r=>r.status==='failed').length;
    const status=failed?(completed||queued?'partial':'failed'):queued?'submitted':'completed';
    const error=results.filter(r=>r.error).map(r=>r.ticker+': '+r.error).join(' | ').slice(0,1000)||null;
    await sql.query("UPDATE wealth_stock_advisor_schedule_runs SET status=$2,finished_at=now(),tickers_total=$3,tickers_submitted=$4,tickers_failed=$5,result_json=$6::jsonb,last_error=$7,updated_at=now() WHERE id=$1",[executionId,status,tickers.length,completed+queued,failed,JSON.stringify(results),error]);
    const next=nextScheduledAt(now,settings.schedule_time||DEFAULT_SCHEDULE_TIME,settings.schedule_frequency||'daily',SCHEDULE_TIMEZONE).toISOString();
    await sql.query("UPDATE wealth_stock_advisor_settings SET last_run_at=now(),last_success_at=CASE WHEN $2 IN ('submitted','completed') THEN now() ELSE last_success_at END,last_scheduled_date=CASE WHEN $3='scheduled' AND $2 IN ('submitted','completed') THEN $4::date ELSE last_scheduled_date END,last_status=$2,last_error=$5,next_run_at=$6,updated_at=now() WHERE user_id=$1::uuid",[uid,status,runType,scheduledDate,error,next]);
    return {status,tickers:tickers.length,completed,queued,failed,results};
  } catch(error) {
    const message=String(error?.message||error).slice(0,1000);
    await sql.query("UPDATE wealth_stock_advisor_schedule_runs SET status='failed',finished_at=now(),last_error=$2,updated_at=now() WHERE id=$1",[executionId,message]).catch(()=>{});
    await sql.query("UPDATE wealth_stock_advisor_settings SET last_status='failed',last_error=$2,updated_at=now() WHERE user_id=$1::uuid",[uid,message]).catch(()=>{});
    throw error;
  }
}
export async function runScheduledTick(now=new Date()) {
  const users=await sql.query("SELECT s.user_id,s.enabled,s.mode,s.selected_tickers,s.schedule_timezone,s.schedule_time,s.schedule_frequency,s.last_scheduled_date,u.session_version FROM wealth_stock_advisor_settings s JOIN wealth_users u ON u.id=s.user_id WHERE s.enabled=true ORDER BY s.updated_at");
  const results=[];
  for(const user of users) {
    const timezone=user.schedule_timezone||SCHEDULE_TIMEZONE;
    if(timezone!==SCHEDULE_TIMEZONE) {
      results.push({user_id:user.user_id,status:'failed',error:'Only Asia/Kolkata is currently supported.'});
      continue;
    }
    const dueDates=dueScheduleDates(now,user.last_scheduled_date,user.schedule_time||DEFAULT_SCHEDULE_TIME,user.schedule_frequency||'daily',timezone,3);
    for(const dateKey of dueDates) {
      const scheduledFor=zonedDateTimeToUtc({year:Number(dateKey.slice(0,4)),month:Number(dateKey.slice(5,7)),day:Number(dateKey.slice(8,10)),hour:Number(user.schedule_time.slice(0,2)),minute:Number(user.schedule_time.slice(3,5))},timezone);
      const executionKey='scheduled:'+dateKey;
      const inserted=await sql.query("INSERT INTO wealth_stock_advisor_schedule_runs (user_id,execution_key,run_type,scheduled_date,scheduled_for,status,created_at,updated_at) VALUES ($1::uuid,$2,'scheduled',$3::date,$4,'queued',now(),now()) ON CONFLICT (user_id,execution_key) DO UPDATE SET status='queued',last_error=NULL,updated_at=now() WHERE wealth_stock_advisor_schedule_runs.status IN ('failed','partial') AND wealth_stock_advisor_schedule_runs.attempt_count<3 RETURNING id",[user.user_id,executionKey,dateKey,scheduledFor.toISOString()]);
      if(!inserted.length) {
        const [prior]=await sql.query('SELECT status,attempt_count FROM wealth_stock_advisor_schedule_runs WHERE user_id=$1::uuid AND execution_key=$2',[user.user_id,executionKey]);
        if(prior?.status==='failed' && Number(prior.attempt_count||0)>=3) {
          await sql.query("UPDATE wealth_stock_advisor_settings SET last_scheduled_date=$2::date,last_status='failed',last_error='Scheduled run reached its retry limit; moving to the next eligible date.',updated_at=now() WHERE user_id=$1::uuid",[user.user_id,dateKey]);
        }
        continue;
      }
      const settings={...user,selected_tickers:user.selected_tickers};
      try {
        const outcome=await executeUserResearch({uid:user.user_id,sessionVersion:Number(user.session_version||1),settings,executionId:inserted[0].id,executionKey,runType:'scheduled',scheduledDate:dateKey,now});
        results.push({user_id:user.user_id,date:dateKey,...outcome});
        if(['failed','partial','skipped'].includes(outcome.status))break;
      } catch(error) {
        results.push({user_id:user.user_id,date:dateKey,status:'failed',error:String(error?.message||error).slice(0,240)});
        break;
      }
    }
  }
  return {checked:users.length,results};
}
