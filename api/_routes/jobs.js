import { sql, json, sessionUser } from '../_lib.js';
import { queueCounts } from '../_lib/job-queue.js';

async function adminUser(req) {
  const uid=await sessionUser(req);
  if(!uid)return null;
  const [user]=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  return user?.role==='admin'?uid:null;
}
export default async function handler(req,res) {
  try {
    if(!sql)return json(res,503,{error:'Database is not configured'});
    if(req.method!=='GET'&&req.method!=='PUT')return json(res,405,{error:'Method not allowed'});
    const uid=await adminUser(req);
    if(!uid)return json(res,403,{error:'Admin sign-in required'});
    if(req.method==='GET'){
      const jobs=await sql.query(`SELECT j.id,j.job_key,j.name,j.description,j.enabled,
        to_char(j.schedule_time,'HH24:MI') AS schedule_time,j.schedule_frequency,j.timezone,j.next_run_at,
        CASE WHEN j.handler_key IN ('interest-accrual','backup') THEN
          COALESCE((SELECT r.started_at FROM wealth_job_runs r WHERE r.job=j.handler_key ORDER BY r.started_at DESC LIMIT 1),j.last_run_at)
          ELSE j.last_run_at END AS last_run_at,
        CASE WHEN j.handler_key IN ('interest-accrual','backup') THEN
          COALESCE((SELECT r.status FROM wealth_job_runs r WHERE r.job=j.handler_key ORDER BY r.started_at DESC LIMIT 1),j.last_status)
          ELSE j.last_status END AS last_status,
        CASE WHEN j.handler_key IN ('interest-accrual','backup') THEN
          (SELECT r.summary->>'error' FROM wealth_job_runs r WHERE r.job=j.handler_key ORDER BY r.started_at DESC LIMIT 1)
          ELSE j.last_error END AS last_error,
        (SELECT count(*)::int FROM wealth_job_queue q WHERE q.job_id=j.id AND q.status IN ('pending','running')) AS queued,
        CASE WHEN j.handler_key IN ('interest-accrual','backup') THEN
          COALESCE((SELECT json_agg(x ORDER BY x.created_at DESC) FROM
            (SELECT r.id,'nightly-cron'::text AS trigger_type,r.status,r.started_at,r.finished_at,
              NULL::int AS http_status,r.summary->>'error' AS error,r.summary AS result,r.started_at AS created_at
             FROM wealth_job_runs r WHERE r.job=j.handler_key ORDER BY r.started_at DESC LIMIT 10) x),
            '[]'::json)
          ELSE (SELECT json_agg(x ORDER BY x.created_at DESC) FROM
            (SELECT id,trigger_type,status,started_at,finished_at,http_status,error,result,created_at
             FROM wealth_scheduled_job_runs r WHERE r.job_id=j.id ORDER BY r.created_at DESC LIMIT 10) x)
        END AS recent_runs
        FROM wealth_scheduled_jobs j ORDER BY j.schedule_time,j.name`);
      const scheduler=await sql.query(`SELECT DISTINCT ON (job) job,started_at,finished_at,status,summary
        FROM wealth_job_runs WHERE job IN ('jobs-dispatch','jobs-worker') ORDER BY job,started_at DESC`).catch(()=>[]);
      const schedulerActivity={dispatcher:scheduler.find(x=>x.job==='jobs-dispatch')||null,worker:scheduler.find(x=>x.job==='jobs-worker')||null};
      return json(res,200,{jobs,queue:await queueCounts(sql),schedulerActivity});
    }
    const body=await (async()=>{let raw='';for await(const c of req)raw+=c;if(raw.length>5000)throw new Error('Request too large');return JSON.parse(raw||'{}')})();
    const id=String(body.id||'');
    const time=String(body.schedule_time||'');
    const frequency=String(body.schedule_frequency||'daily');
    if(!id)return json(res,400,{error:'Job id is required.'});
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return json(res,400,{error:'Schedule time must be HH:MM.'});
    if(time>'18:45')return json(res,400,{error:'On the free Vercel plan, automatic jobs dispatch once daily at 18:45 IST. Choose a due-time no later than 18:45.'});
    if(!['daily','weekdays'].includes(frequency))return json(res,400,{error:'Frequency must be daily or weekdays.'});
    if(typeof body.enabled!=='boolean')return json(res,400,{error:'enabled must be true or false.'});
    const [current]=await sql.query('SELECT id,schedule_time::text,schedule_frequency,timezone FROM wealth_scheduled_jobs WHERE id=$1',[id]);
    if(!current)return json(res,404,{error:'Job not found.'});
    const {nextJobRun}=await import('../_lib/scheduled-job-time.js');
    const next=body.enabled?nextJobRun(new Date(),time,frequency,current.timezone):null;
    await sql.query(`UPDATE wealth_scheduled_jobs SET enabled=$2,schedule_time=$3::time,schedule_frequency=$4,
      next_run_at=$5,updated_at=now() WHERE id=$1`,[id,body.enabled,time,frequency,next?.toISOString()||null]);
    return json(res,200,{saved:true});
  } catch(error) {
    console.error('[scheduled-jobs]',error?.message||error);
    return json(res,500,{error:error?.message||'Could not update job.'});
  }
}
