import { sql, json, safeEqual } from '../_lib.js';
import { dispatchDueJobs } from '../_lib/scheduled-jobs.js';
export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  try{
    const result=await dispatchDueJobs();
    const failedJobs=(result.queued||[]).filter(x=>x.status==='failed');
    const failedTasks=(result.drained?.outcomes||[]).filter(x=>x.execution==='failed');
    const ok=failedJobs.length===0&&failedTasks.length===0;
    return json(res,ok?200:500,{ok,status:ok?'completed':'failed',...result,failedJobs,failedTasks});
  }catch(error){console.error('[jobs-dispatch]',error?.message||error);return json(res,500,{ok:false,status:'failed',error:String(error?.message||'Scheduled job dispatch failed.').slice(0,300)})}
}
