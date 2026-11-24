import { sql, json, safeEqual, sessionUser } from '../_lib.js';
import { drainJobQueue, reapStalled, DISPATCH_BUDGET_MS } from '../_lib/scheduled-jobs.js';
import { startJob, finishJob } from '../_jobs.js';

// GET/POST /api/jobs/worker — take queued work and run it until this call's time is used.
// Invoked by Vercel Cron and by an authenticated admin. The queue is durable; unfinished work remains for the next worker.
export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  const cron=secret.length>=16&&safeEqual(String(req.headers.authorization||''),'Bearer '+secret);
  if(!cron){
    const uid=await sessionUser(req);
    if(!uid)return json(res,401,{error:'Sign in required'});
    const [user]=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
    if(user?.role!=='admin')return json(res,403,{error:'Admin only'});
  }
  const run=await startJob('jobs-worker');
  try{
    const deadlineAt=Date.now()+DISPATCH_BUDGET_MS;
    const reaped=await reapStalled(sql);
    const result=await drainJobQueue(deadlineAt);
    const failedTasks=(result.outcomes||[]).filter(x=>x.execution==='failed');
    const ok=failedTasks.length===0;
    const summary={processed:result.processed||0,queue:result.queue||{},failedTasks,reaped};
    await finishJob(run,ok?'succeeded':'failed',summary);
    // The worker ran, so this is a 200 even when a task inside it failed: a provider that rate-limits or times out is an
    // outcome to report, not a transport error. Returning 500 made "Run queue now" tell the admin the whole pass had
    // failed when it had in fact done its work, and hid how much it got through (2026-11-24).
    const status=failedTasks.length?'failed_tasks':result.queue?.waiting?'partial':'completed';
    return json(res,200,{ok,status,reaped,...result,failedTasks});
  }catch(error){
    const message=String(error?.message||'Job worker failed.').slice(0,300);
    await finishJob(run,'failed',{error:message});
    console.error('[jobs-worker]',message);
    return json(res,500,{ok:false,status:'failed',error:message});
  }
}
