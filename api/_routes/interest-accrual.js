import { sql,json,safeEqual,ownerId,invalidateUserCaches } from '../_lib.js';
import { runAccrual } from '../_interest.js';
import { startJob,finishJob } from '../_jobs.js';

export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const secret=String(process.env.CRON_SECRET||'').trim();
  if(secret.length<16||!safeEqual(String(req.headers.authorization||''),'Bearer '+secret))return json(res,401,{error:'Unauthorized'});
  if(!sql)return json(res,503,{error:'Database is not configured'});
  const run=await startJob('interest-accrual');
  try{
    const uid=await ownerId();
    const others=(await sql.query(`SELECT DISTINCT a.user_id FROM wealth_interest_links l JOIN wealth_accounts a ON a.id=l.account_id
      WHERE a.status='active'`).catch(()=>[])).map(r=>r.user_id).filter(u=>u&&u!==uid);
    const result=uid?await runAccrual(uid,{actor:'cron'}):{accounts:[]};
    let rows=result.accounts.reduce((sum,a)=>sum+a.rowsWritten,0),failed=0;
    if(uid)await invalidateUserCaches(uid);
    for(const userId of others){
      try{const other=await runAccrual(userId,{actor:'cron'});rows+=other.accounts.reduce((sum,a)=>sum+a.rowsWritten,0);await invalidateUserCaches(userId)}
      catch(error){failed++;console.error('[interest-accrual:user]',error?.message||error)}
    }
    await finishJob(run,failed?'partial':'succeeded',{through:result.through,rows,users:(uid?1:0)+others.length,failed});
    return json(res,200,{ok:failed===0,through:result.through,rows,users:(uid?1:0)+others.length,failed});
  }catch(error){
    await finishJob(run,'failed',{error:String(error?.message||error).slice(0,300)});
    console.error('[interest-accrual]',error?.message||error);
    return json(res,500,{error:'Interest accrual failed.'});
  }
}
