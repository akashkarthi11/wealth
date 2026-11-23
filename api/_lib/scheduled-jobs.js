import { randomUUID } from 'node:crypto';
import { sql } from '../_lib.js';
import marketPriceRefresh from '../_routes/refresh-market-prices.js';
import interestAccrual from '../_routes/interest-accrual.js';
import backupJob from '../_routes/backup.js';
import stockAdvisorResearch from '../_routes/stock-advisor-scheduled.js';
import stockAdvisorCollection from '../_routes/stock-advisor-data-collection.js';
import { nextJobRun } from './scheduled-job-time.js';
import { enqueueItems, drainQueue, reapStalled, finishJobRun, queueCounts, DISPATCH_BUDGET_MS } from './job-queue.js';
import { startCollectionRun, planCollection } from './stock-advisor-data-collection.js';
export { DISPATCH_BUDGET_MS, reapStalled, queueCounts };

const HANDLERS = {
  'market-price-refresh': marketPriceRefresh,
  'interest-accrual': interestAccrual,
  'backup': backupJob,
  'stock-advisor-auto-research': stockAdvisorResearch,
  'stock-advisor-data-collection': stockAdvisorCollection
};
// Queue order between jobs: lower runs first. The collection's own tasks use 40-44 (see TASKS in stock-advisor-data-collection.js).
const JOB_PRIORITY = { 'interest-accrual': 10, 'backup': 20, 'market-price-refresh': 30, 'stock-advisor-auto-research': 90 };
const WHOLE_JOB_MIN_BUDGET_MS = 15000;

function fakeResponse(){
  return {statusCode:200,headers:{},body:'',setHeader(k,v){this.headers[k]=v;},end(v=''){this.body=String(v);return this;}};
}
async function invoke(handler,token,deadlineAt) {
  const req={method:'POST',url:'/api/internal-scheduled-job',headers:{authorization:'Bearer '+token},route:'internal-scheduled-job',deadlineAt};
  const res=fakeResponse();
  await handler(req,res);
  let payload={};try{payload=JSON.parse(res.body||'{}')}catch{payload={message:String(res.body||'').slice(0,500)}}
  return {http_status:res.statusCode||200,payload};
}
async function runHandler(handlerKey,deadlineAt) {
  const handler=HANDLERS[handlerKey];
  if(!handler)throw new Error('No handler registered for '+handlerKey);
  const token=String(process.env.CRON_SECRET||'').trim();
  if(token.length<16)throw new Error('CRON_SECRET is not configured.');
  return invoke(handler,token,deadlineAt);
}

// A job can start when it is due (or run by hand), nobody else holds it, and its previous run has nothing left on the queue.
async function claimJob(job,triggerType,db=sql) {
  const lock=randomUUID();
  const rows=await db.query(`UPDATE wealth_scheduled_jobs
    SET locked_until=now()+interval '12 minutes',lock_token=$2,updated_at=now()
    WHERE id=$1 AND (locked_until IS NULL OR locked_until<now())
      AND NOT EXISTS (SELECT 1 FROM wealth_job_queue q WHERE q.job_id=wealth_scheduled_jobs.id AND q.status IN ('pending','running'))
      AND ($3='manual' OR (enabled=true AND next_run_at<=now()))
    RETURNING id,job_key,handler_key,name,schedule_time::text,schedule_frequency,timezone,next_run_at`,[job.id,lock,triggerType]);
  if(!rows.length)return null;
  const claimed=rows[0];
  if(triggerType==='scheduled'){
    const next=nextJobRun(new Date(),String(claimed.schedule_time).slice(0,5),claimed.schedule_frequency,claimed.timezone);
    await db.query('UPDATE wealth_scheduled_jobs SET next_run_at=$2 WHERE id=$1 AND lock_token=$3',[claimed.id,next.toISOString(),lock]);
  }
  const [run]=await db.query(`INSERT INTO wealth_scheduled_job_runs(job_id,trigger_type,status)
    VALUES($1,$2,'running') RETURNING id`,[claimed.id,triggerType]);
  return {...claimed,lock_token:lock,run_id:run.id};
}

// Put a job on the queue (nothing runs yet). The data collection is planned into one item per provider call; any other job is one item.
export async function enqueueJob(job,triggerType='scheduled',db=sql) {
  const claimed=await claimJob(job,triggerType,db);
  if(!claimed)return {job_key:job.job_key,status:'busy'};
  try{
    let rows;
    if(claimed.handler_key==='stock-advisor-data-collection'){
      const collectionRunId=await startCollectionRun(db);
      const plan=await planCollection(db);
      await db.query(`UPDATE wealth_stock_advisor_data_collection_runs SET summary=summary||jsonb_build_object('instruments',$2::int,'queued',$3::int) WHERE id=$1`,[collectionRunId,plan.instruments,plan.tasks.length]);
      if(!plan.tasks.length){
        const payload={ok:true,status:'succeeded',run_id:collectionRunId,instruments:plan.instruments,message:'No active holding has both a symbol and a price-source symbol, so there was nothing to collect.'};
        await db.query(`UPDATE wealth_stock_advisor_data_collection_runs SET status='succeeded',finished_at=now() WHERE id=$1`,[collectionRunId]);
        await finishJobRun(db,{runId:claimed.run_id,jobId:claimed.id,status:'succeeded',http:200,payload});
        return {job_key:claimed.job_key,status:'succeeded',queued:0};
      }
      rows=plan.tasks.map((t,seq)=>({job_id:claimed.id,job_run_id:claimed.run_id,handler_key:claimed.handler_key,task:t.task,payload:{...t.payload,collection_run_id:collectionRunId},
        priority:t.priority,min_budget_ms:t.min_budget_ms,max_attempts:2,seq}));
    }else{
      rows=[{job_id:claimed.id,job_run_id:claimed.run_id,handler_key:claimed.handler_key,task:'run',payload:{},priority:JOB_PRIORITY[claimed.handler_key]??50,min_budget_ms:WHOLE_JOB_MIN_BUDGET_MS,max_attempts:1,seq:0}];
    }
    await enqueueItems(db,rows);
    return {job_key:claimed.job_key,status:'queued',queued:rows.length};
  }catch(error){
    const message=String(error?.message||error).slice(0,1000);
    await finishJobRun(db,{runId:claimed.run_id,jobId:claimed.id,status:'failed',payload:{error:message},error:message}).catch(()=>{});
    throw error;
  }
}

// Work through the queue (one item at a time) until the deadline.
export function drainJobQueue(deadlineAt=Date.now()+DISPATCH_BUDGET_MS,db=sql) {
  return drainQueue({db,runHandler,deadlineAt});
}

// Run now: queue the job, then work the queue for the time this call has. Anything not reached stays queued.
export async function runJobNow(job,db=sql) {
  const queued=await enqueueJob(job,'manual',db);
  if(queued.status==='busy')return queued;
  const drained=await drainJobQueue(Date.now()+DISPATCH_BUDGET_MS,db);
  return {...queued,drained};
}

// The daily dispatch: close what was cut off, queue every due job, then work the queue for this call's time. The rest is picked up by the
// next worker call (extra cron entries, or Run now / the open Scheduled jobs page).
export async function dispatchDueJobs() {
  const deadlineAt=Date.now()+DISPATCH_BUDGET_MS;
  const reaped=await reapStalled(sql).catch(()=>null);
  const due=await sql.query(`SELECT * FROM wealth_scheduled_jobs WHERE enabled=true AND next_run_at<=now()
    AND (locked_until IS NULL OR locked_until<now()) ORDER BY CASE handler_key
    WHEN 'interest-accrual' THEN 1 WHEN 'backup' THEN 2 WHEN 'market-price-refresh' THEN 3
    WHEN 'stock-advisor-data-collection' THEN 4 WHEN 'stock-advisor-auto-research' THEN 5 ELSE 99 END LIMIT 8`);
  const queued=[];
  for(const job of due){
    try{queued.push(await enqueueJob(job,'scheduled'))}
    catch(error){queued.push({job_key:job.job_key,status:'failed',error:String(error?.message||error).slice(0,300)})}
  }
  const drained=await drainJobQueue(deadlineAt);
  return {checked:due.length,reaped,queued,drained};
}
