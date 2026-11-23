import { sql, json, safeEqual, sessionUser } from '../_lib.js';
import { drainJobQueue, reapStalled, DISPATCH_BUDGET_MS } from '../_lib/scheduled-jobs.js';

// GET/POST /api/jobs/worker — take items off the job queue and run them, one at a time, until this call's time is used.
// Called by the cron entries in vercel.json (Bearer CRON_SECRET) and, while the Scheduled jobs or AI data page is open, by the admin's browser.
// It never queues anything itself; the dispatch and Run now do that.
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
    const reaped=await reapStalled(sql).catch(()=>null);
    return json(res,200,{ok:true,reaped,...await drainJobQueue(deadlineAt)});
  }catch(error){
    console.error('[jobs-worker]',error?.message||error);
    return json(res,500,{error:'Job worker failed.'});
  }
}
