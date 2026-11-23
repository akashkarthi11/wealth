import { sql, json, safeEqual } from '../_lib.js';
import { startJob, finishJob } from '../_jobs.js';
import { runScheduledTick } from '../_lib/stock-advisor-schedule-service.js';

// Invoked by the central Hobby-plan dispatcher once daily at 18:45 IST; saved per-user times are due-time cutoffs.
// Preview deployments do not receive Vercel Cron events; Run Now remains user-authenticated for Preview testing.
export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  const job=await startJob('stock-advisor-auto-research');
  try {
    const result=await runScheduledTick(new Date());
    const failed=result.results.filter(x=>x.status==='failed'||x.status==='partial').length;
    const researchLaunched=result.results.some(x=>['submitted','completed'].includes(x.status));
    const status=failed?(failed===result.results.length?'failed':'partial'):researchLaunched?'succeeded':'skipped';
    const outcome={...result,research_launched:researchLaunched,outcome:researchLaunched?'research_submitted_or_completed':'no_work_due'};
    await finishJob(job,status,outcome);
    return json(res,200,{ok:failed===0,status,research_launched:researchLaunched,scheduled_window:'18:45 IST (Asia/Kolkata) central daily dispatcher',timezone:'Asia/Kolkata',...outcome,limitations:['The central dispatcher runs once daily at 18:45 IST on the Hobby plan.','The selected schedule time is a due-time cutoff no later than 09:48 IST; it is not an exact-minute execution promise.','Preview deployments do not receive Vercel Cron events.','Research runs are queued through the resumable debate worker; no orders or portfolio records are changed.']});
  } catch(error) {
    await finishJob(job,'failed',{error:String(error?.message||error).slice(0,300)});
    console.error('[stock-advisor-scheduled]',error?.message||error);
    return json(res,500,{error:'Scheduled Auto Research failed.'});
  }
}
