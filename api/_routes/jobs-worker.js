import { sql, json, safeEqual, sessionUser } from '../_lib.js';
import { drainJobQueue, reapStalled, DISPATCH_BUDGET_MS } from '../_lib/scheduled-jobs.js';

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
  try{
    const deadlineAt=Date.now()+DISPATCH_BUDGET_MS;
    const reaped=await reapStalled(sql);
    const result=await drainJobQueue(deadlineAt);
    const failedTasks=(result.outcomes||[]).filter(x=>x.execution==='failed');
    const ok=failedTasks.length===0;
    return json(res,ok?200:500,{ok,status:ok?(result.queue?.waiting?'partial':'completed'):'failed',reaped,...result,failedTasks});
  }catch(error){
    console.error('[jobs-worker]',error?.message||error);
    return json(res,500,{ok:false,status:'failed',error:String(error?.message||'Job worker failed.').slice(0,300)});
  }
}
