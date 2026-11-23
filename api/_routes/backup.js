import { sql,json,safeEqual } from '../_lib.js';
import { runBackup } from '../_backup.js';
import { startJob,finishJob } from '../_jobs.js';

export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  const run=await startJob('backup');
  try{
    const result=await runBackup();
    await finishJob(run,'succeeded',result);
    return json(res,200,{ok:true,...result});
  }catch(error){
    const notConfigured=error?.code==='CONFIG';
    await finishJob(run,notConfigured?'partial':'failed',{error:String(error?.message||error).slice(0,300),notConfigured});
    console.error('[scheduled-backup]',error?.message||error);
    return json(res,notConfigured?200:500,{ok:false,error:notConfigured?error.message:'Backup failed.',notConfigured});
  }
}
