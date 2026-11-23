import { sql, json, safeEqual } from '../_lib.js';
import { dispatchDueJobs } from '../_lib/scheduled-jobs.js';
export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  try{return json(res,200,{ok:true,...await dispatchDueJobs()})}
  catch(error){console.error('[jobs-dispatch]',error?.message||error);return json(res,500,{error:'Scheduled job dispatch failed.'})}
}
