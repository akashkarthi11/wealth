import { randomUUID } from 'node:crypto';
import { sql, schema, json, sessionUser, body } from '../_lib.js';
import { executeUserResearch } from '../_lib/stock-advisor-schedule-service.js';
import {
  SCHEDULE_TIMEZONE, DEFAULT_SCHEDULE_TIME, HOBBY_POLL_WINDOW,
  isValidScheduleTime, nextScheduledAt, formatScheduleTime
} from '../_lib/stock-advisor-schedule-time.js';

function defaultSettings() {
  return {enabled:false,mode:'all',selected_tickers:[],schedule_timezone:SCHEDULE_TIMEZONE,schedule_time:DEFAULT_SCHEDULE_TIME,schedule_frequency:'daily',last_run_at:null,last_success_at:null,next_run_at:null,last_status:'not_configured',last_error:null};
}
async function loadSchedule(uid) {
  const rows=await sql.query('SELECT enabled,mode,selected_tickers,schedule_timezone,schedule_time,schedule_frequency,last_run_at,last_success_at,last_scheduled_date,next_run_at,last_status,last_error,updated_at FROM wealth_stock_advisor_settings WHERE user_id=$1',[uid]);
  const settings={...defaultSettings(),...(rows[0]||{})};
  const next=settings.enabled?nextScheduledAt(new Date(),settings.schedule_time,settings.schedule_frequency,settings.schedule_timezone).toISOString():null;
  return {
    ...settings,next_run_at:next,
    next_run_at_ist:next?formatScheduleTime(new Date(next),SCHEDULE_TIMEZONE):null,
    last_success_at_ist:settings.last_success_at?formatScheduleTime(new Date(settings.last_success_at),SCHEDULE_TIMEZONE):null,
    scheduler_registered:String(process.env.VERCEL_ENV||'').toLowerCase()==='production',
    scheduler_status:!settings.enabled?'disabled':String(process.env.VERCEL_ENV||'').toLowerCase()==='production'?'active':'preview_only',
    execution_window:HOBBY_POLL_WINDOW,
    precision_note:'Vercel Hobby checks once per day. The fixed trigger runs in the 09:48–10:47 IST window; the selected time is a due-time cutoff, not an exact-minute promise.'
  };
}
async function getSchedule(req,res) {
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const settings=await loadSchedule(uid);
  const recent=await sql.query("SELECT id,run_type,scheduled_for,started_at,finished_at,status,tickers_total,tickers_submitted,tickers_failed,last_error FROM wealth_stock_advisor_schedule_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[uid]);
  return json(res,200,{...settings,last_execution:recent[0]||null});
}
async function putSchedule(req,res) {
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const input=await body(req);
  if(typeof input.enabled!=='boolean')return json(res,400,{error:'enabled must be true or false.'});
  const time=String(input.schedule_time??input.time??'').trim();
  if(!isValidScheduleTime(time))return json(res,400,{error:'Choose a valid IST time no later than 09:48. Hobby Cron checks once daily in the 09:48–10:47 IST window.'});
  const [coverage]=await sql.query('SELECT mode,selected_tickers FROM wealth_stock_advisor_settings WHERE user_id=$1',[uid]);
  const currentSelected=Array.isArray(coverage?.selected_tickers)?coverage.selected_tickers:(typeof coverage?.selected_tickers==='string'?JSON.parse(coverage.selected_tickers||'[]'):[]);
  if(input.enabled && coverage?.mode==='manual' && !currentSelected.length)return json(res,400,{error:'Select at least one saved investment before enabling the schedule.'});
  const frequency=String(input.frequency??input.schedule_frequency??'daily');
  if(!['daily','weekdays'].includes(frequency))return json(res,400,{error:'Frequency must be daily or weekdays.'});
  const timezone=String(input.timezone??input.schedule_timezone??SCHEDULE_TIMEZONE);
  if(timezone!==SCHEDULE_TIMEZONE)return json(res,400,{error:'Only Asia/Kolkata (IST) is currently supported.'});
  const next=input.enabled?nextScheduledAt(new Date(),time,frequency,timezone).toISOString():null;
  await sql.query("INSERT INTO wealth_stock_advisor_settings (user_id,enabled,mode,selected_tickers,schedule_timezone,schedule_time,schedule_frequency,next_run_at,last_status,last_error,updated_at) VALUES ($1,$2,'all','[]'::jsonb,$3,$4,$5,$6,$7,NULL,now()) ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled,schedule_timezone=EXCLUDED.schedule_timezone,schedule_time=EXCLUDED.schedule_time,schedule_frequency=EXCLUDED.schedule_frequency,next_run_at=EXCLUDED.next_run_at,last_status=CASE WHEN EXCLUDED.enabled THEN 'scheduled' ELSE 'disabled' END,last_error=NULL,updated_at=now()",[uid,input.enabled,timezone,time,frequency,next,input.enabled?'scheduled':'disabled']);
  return json(res,200,{saved:true,settings:await loadSchedule(uid)});
}
async function runNow(req,res) {
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const [user]=await sql.query('SELECT session_version FROM wealth_users WHERE id=$1',[uid]);
  if(!user)return json(res,401,{error:'Account session is no longer valid.'});
  const [settingsRow]=await sql.query('SELECT * FROM wealth_stock_advisor_settings WHERE user_id=$1',[uid]);
  const settings={...defaultSettings(),...(settingsRow||{})};
  await sql.query("UPDATE wealth_stock_advisor_schedule_runs SET status='failed',last_error='Manual execution lease expired before completion.',finished_at=now(),updated_at=now() WHERE user_id=$1 AND run_type='manual' AND status IN ('queued','running') AND updated_at<now()-interval '30 minutes'",[uid]);
  const key='manual:'+randomUUID();
  const rows=await sql.query("WITH lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext($1::text))), active AS MATERIALIZED (SELECT r.id,r.status FROM wealth_stock_advisor_schedule_runs r CROSS JOIN lock WHERE r.user_id=$1 AND r.run_type='manual' AND (r.status IN ('queued','running') OR (r.status='submitted' AND r.created_at>now()-interval '15 minutes')) ORDER BY r.created_at DESC LIMIT 1), inserted AS (INSERT INTO wealth_stock_advisor_schedule_runs (user_id,execution_key,run_type,scheduled_for,status,created_at,updated_at) SELECT $1,$2,'manual',now(),'queued',now(),now() FROM lock WHERE NOT EXISTS (SELECT 1 FROM active) RETURNING id,status) SELECT id,status,true AS reused FROM active UNION ALL SELECT id,status,false AS reused FROM inserted LIMIT 1",[uid,key]);
  if(!rows.length)return json(res,409,{error:'Could not acquire the research execution lock. Try again shortly.'});
  if(rows[0].reused)return json(res,202,{ok:true,reused:true,execution_id:rows[0].id,status:rows[0].status,message:'A recent Run Now request is already in progress.'});
  try {
    const result=await executeUserResearch({uid,sessionVersion:Number(user.session_version||1),settings,executionId:rows[0].id,executionKey:key,runType:'manual'});
    return json(res,202,{ok:!['failed','partial'].includes(result.status),execution_id:rows[0].id,...result});
  } catch(error) {
    return json(res,502,{ok:false,execution_id:rows[0].id,status:'failed',error:String(error?.message||error).slice(0,300)});
  }
}
export default async function handler(req,res) {
  try {
    await schema();
    if(req.route==='stock-advisor/schedule'&&req.method==='GET')return await getSchedule(req,res);
    if(req.route==='stock-advisor/schedule'&&req.method==='PUT')return await putSchedule(req,res);
    if(req.route==='stock-advisor/schedule/run-now'&&req.method==='POST')return await runNow(req,res);
    return json(res,405,{error:'Method not allowed'});
  } catch(error) {
    console.error('[stock-advisor-schedule]',error?.message||error);
    return json(res,error?.status||500,{error:error?.message||'Schedule request failed.'});
  }
}
