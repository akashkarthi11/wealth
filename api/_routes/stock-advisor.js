import {sql,schema,json,sessionUser,body} from '../_lib.js';
import {timingSafeEqual} from 'node:crypto';
import {startJob,finishJob} from '../_jobs.js';

// The agents' shared WEALTH_INGEST_SECRET (Plan 3) or the older advisor-only secret.
function validIngestSecret(req){
 const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 return [process.env.WEALTH_INGEST_SECRET,process.env.WEALTH_ADVISOR_INGEST_SECRET].some(v=>{
  const expected=String(v||'').trim();
  if(expected.length<32||supplied.length!==expected.length)return false;
  try{return timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))}catch{return false}
 });
}

async function latestSavedReport(uid){
 let reports=[];
 try{
  reports=await sql.query('SELECT id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 1',[uid]);
 }catch(error){
  console.warn('[wealth-stock-advisor:report-table]',error?.message||error);
 }
 if(reports.length)return reports[0];
 // Backward-compatible fallback: the hourly monitor already stores Stock Advisor
 // reports as wealth_snapshots while the dedicated report table is being provisioned.
 const snapshots=await sql.query(
  "SELECT id,snapshot_date AS run_at,payload FROM wealth_snapshots WHERE user_id=$1 AND (source_key ILIKE 'stock-advisor%' OR source_name ILIKE '%stock advisor%') ORDER BY snapshot_date DESC,created_at DESC LIMIT 1",
  [uid]
 );
 if(!snapshots.length)return null;
 let payload=snapshots[0].payload;
 if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload={summary:payload}}}
 payload=payload&&typeof payload==='object'?payload:{};
 const reportJson=payload.report_json||payload.reportJson||payload;
 return {
  id:snapshots[0].id,
  run_at:snapshots[0].run_at,
  report_text:payload.report_text||payload.reportText||payload.summary||payload.text||'',
  report_json:reportJson
 };
}

export default async function handler(req,res){
 try{
  await schema();
  if(req.method==='POST'){
   if(!validIngestSecret(req))return json(res,401,{error:'Valid advisor ingest token required.'});
   const input=await body(req);
   const reportJson=input.report_json??input.reportJson;
   if(!reportJson||typeof reportJson!=='object'||Array.isArray(reportJson))return json(res,400,{error:'report_json must be a JSON object.'});
   const reportText=String(input.report_text??input.reportText??reportJson.summary??'').trim();
   if(!reportText&&!Array.isArray(reportJson.recommendations))return json(res,400,{error:'Provide report_text or structured recommendations.'});
   const runAt=input.run_at??input.runAt??null;
   if(runAt&&(!Number.isFinite(Date.parse(runAt))))return json(res,400,{error:'run_at must be a valid ISO date.'});
   const admins=await sql.query("SELECT id FROM wealth_users WHERE role='admin' LIMIT 1");
   if(!admins.length)return json(res,409,{error:'No admin account is configured for advisor reports.'});
   // (user_id, run_at) is unique since migration 0002: posting the same run twice is not an error.
   const saved=await sql.query(
    'INSERT INTO wealth_stock_advisor_reports (user_id,run_at,report_text,report_json) VALUES ($1,COALESCE($2::timestamptz,now()),$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id,run_at',
    [admins[0].id,runAt,reportText,JSON.stringify(reportJson)]
   );
   const run=await startJob('advisor-ingest');
   await finishJob(run,'succeeded',{saved:saved.length===1,runAt:saved[0]?.run_at||runAt});
   if(!saved.length)return json(res,200,{saved:false,alreadySaved:true});
   return json(res,201,{saved:true,report:saved[0]});
  }
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const [report,holdings]=await Promise.all([
   latestSavedReport(uid),
   sql.query("SELECT name,ticker,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type='EQUITY' AND currency='INR' ORDER BY name",[uid])
  ]);
  return json(res,200,{report,holdings});
 }catch(e){console.error('[wealth-stock-advisor]',e?.message||e);return json(res,500,{error:'Unable to process Stock Advisor data.'})}
}
