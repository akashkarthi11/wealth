import { sql, json, safeEqual } from '../_lib.js';
import { startJob, finishJob } from '../_jobs.js';

// A no-op probe for verifying CRON_SECRET, database connectivity and job-run recording.
// It deliberately does not dispatch queue items or write financial/interest data.
export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<32||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{ok:false,status:'unauthorized',error:'Valid cron secret required.'});
  if(!sql)return json(res,503,{ok:false,status:'failed',error:'Database is not configured'});
  const run=await startJob('jobs-test');
  if(!run)return json(res,500,{ok:false,status:'failed',error:'Could not create test run record.'});
  const summary={probe:true,financial_writes:false,queue_dispatch:false,checked_at:new Date().toISOString()};
  await finishJob(run,'succeeded',summary);
  return json(res,200,{ok:true,status:'succeeded',job:'jobs-test',run_id:run,...summary});
}
