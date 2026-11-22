import { randomUUID } from 'node:crypto';
import { sql } from '../_lib.js';
import marketPriceRefresh from '../_routes/refresh-market-prices.js';
import interestAccrual from '../_routes/interest-accrual.js';
import backupJob from '../_routes/backup.js';
import stockAdvisorResearch from '../_routes/stock-advisor-scheduled.js';
import stockAdvisorCollection from '../_routes/stock-advisor-data-collection.js';

const HANDLERS = {
  'market-price-refresh': marketPriceRefresh,
  'interest-accrual': interestAccrual,
  'backup': backupJob,
  'stock-advisor-auto-research': stockAdvisorResearch,
  'stock-advisor-data-collection': stockAdvisorCollection
};
import { nextJobRun } from './scheduled-job-time.js';
function fakeResponse(){
  return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(v=''){this.body=String(v);return this;}};
}
async function invoke(handler,token) {
  const req={method:'POST',url:'/api/internal-scheduled-job',headers:{authorization:'Bearer '+token},route:'internal-scheduled-job'};
  const res=fakeResponse();
  await handler(req,res);
  let payload={};try{payload=JSON.parse(res.body||'{}')}catch{payload={message:String(res.body||'').slice(0,500)}}
  return {http_status:res.statusCode||200,payload};
}
async function claimJob(job,triggerType) {
  const lock=randomUUID();
  const rows=await sql.query(`UPDATE wealth_scheduled_jobs
    SET locked_until=now()+interval '12 minutes',lock_token=$2,updated_at=now()
    WHERE id=$1 AND (locked_until IS NULL OR locked_until<now())
      AND ($3='manual' OR (enabled=true AND next_run_at<=now()))
    RETURNING id,job_key,handler_key,name,schedule_time::text,schedule_frequency,timezone,next_run_at`,[job.id,lock,triggerType]);
  if(!rows.length)return null;
  const claimed=rows[0];
  if(triggerType==='scheduled'){
    const next=nextJobRun(new Date(),String(claimed.schedule_time).slice(0,5),claimed.schedule_frequency,claimed.timezone);
    await sql.query('UPDATE wealth_scheduled_jobs SET next_run_at=$2 WHERE id=$1 AND lock_token=$3',[claimed.id,next.toISOString(),lock]);
  }
  const [run]=await sql.query(`INSERT INTO wealth_scheduled_job_runs(job_id,trigger_type,status)
    VALUES($1,$2,'running') RETURNING id`,[claimed.id,triggerType]);
  return {...claimed,lock_token:lock,run_id:run.id};
}
export async function executeJob(job,triggerType='scheduled') {
  const claimed=await claimJob(job,triggerType);
  if(!claimed)return {job_key:job.job_key,status:'busy'};
  const handler=HANDLERS[claimed.handler_key];
  if(!handler)throw new Error('No handler registered for '+claimed.handler_key);
  let result;
  try{
    const token=String(process.env.CRON_SECRET||'').trim();
    if(token.length<16)throw new Error('CRON_SECRET is not configured.');
    result=await invoke(handler,token);
    const status=result.http_status>=500||result.http_status===401?'failed':
      result.payload?.ok===false?'partial':'succeeded';
    await sql.query(`UPDATE wealth_scheduled_job_runs SET status=$2,finished_at=now(),http_status=$3,result=$4::jsonb,
      error=$5 WHERE id=$1`,[claimed.run_id,status,result.http_status,JSON.stringify(result.payload),status==='failed'?JSON.stringify(result.payload).slice(0,1500):null]);
    await sql.query(`UPDATE wealth_scheduled_jobs SET last_run_at=now(),last_status=$2,last_error=$3,
      locked_until=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$4`,
      [claimed.id,status,status==='failed'?JSON.stringify(result.payload).slice(0,1000):null,claimed.lock_token]);
    return {job_key:claimed.job_key,status,http_status:result.http_status,result:result.payload};
  }catch(error){
    await sql.query(`UPDATE wealth_scheduled_job_runs SET status='failed',finished_at=now(),error=$2 WHERE id=$1`,
      [claimed.run_id,String(error?.message||error).slice(0,1500)]);
    await sql.query(`UPDATE wealth_scheduled_jobs SET last_run_at=now(),last_status='failed',last_error=$2,
      locked_until=NULL,lock_token=NULL,updated_at=now() WHERE id=$1 AND lock_token=$3`,
      [claimed.id,String(error?.message||error).slice(0,1000),claimed.lock_token]);
    throw error;
  }
}
export async function dispatchDueJobs() {
  const due=await sql.query(`SELECT * FROM wealth_scheduled_jobs WHERE enabled=true AND next_run_at<=now()
    AND (locked_until IS NULL OR locked_until<now()) ORDER BY CASE handler_key
    WHEN 'interest-accrual' THEN 1 WHEN 'backup' THEN 2 WHEN 'market-price-refresh' THEN 3
    WHEN 'stock-advisor-data-collection' THEN 4 WHEN 'stock-advisor-auto-research' THEN 5 ELSE 99 END LIMIT 8`);
  const results=[];
  for(const job of due){
    try{results.push(await executeJob(job,'scheduled'))}
    catch(error){results.push({job_key:job.job_key,status:'failed',error:String(error?.message||error).slice(0,300)})}
  }
  return {checked:due.length,results};
}
