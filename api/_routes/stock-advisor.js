import {sql,schema,json,sessionUser,body} from '../_lib.js';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {startJob,finishJob} from '../_jobs.js';

// The agents' shared WEALTH_INGEST_SECRET (Plan 3) or the older advisor-only secret.
function validIngestSecret(req){
 const supplied=String(req.headers.authorization||'').replace(/^Bearer\\s+/i,'');
 return [process.env.WEALTH_INGEST_SECRET,process.env.WEALTH_ADVISOR_INGEST_SECRET].some(v=>{
  const expected=String(v||'').trim();
  if(expected.length<32||supplied.length!==expected.length)return false;
  try{return timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))}catch{return false}
 });
}

async function latestSavedReport(uid){
 const reports=await sql.query(
  'SELECT id,run_id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 1',[uid]
 );
 if(reports.length)return reports[0];
 // Backward-compatible fallback for older hourly monitor snapshots.
 const snapshots=await sql.query(
  "SELECT id,snapshot_date AS run_at,payload FROM wealth_snapshots WHERE user_id=$1 AND (source_key ILIKE 'stock-advisor%' OR source_name ILIKE '%stock advisor%') ORDER BY snapshot_date DESC,created_at DESC LIMIT 1",
  [uid]
 );
 if(!snapshots.length)return null;
 let payload=snapshots[0].payload;
 if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload={summary:payload}}}
 payload=payload&&typeof payload==='object'?payload:{};
 return {id:snapshots[0].id,run_id:null,run_at:snapshots[0].run_at,
  report_text:payload.report_text||payload.reportText||payload.summary||payload.text||'',
  report_json:payload.report_json||payload.reportJson||payload};
}

function cleanMessages(input){
 if(input==null)return [];
 if(!Array.isArray(input))throw Object.assign(new Error('messages must be an array.'),{status:400});
 if(input.length>500)throw Object.assign(new Error('A run can contain at most 500 messages.'),{status:400});
 return input.map((m,i)=>{
  if(!m||typeof m!=='object'||Array.isArray(m))throw Object.assign(new Error('Each message must be an object.'),{status:400});
  const content=String(m.content??m.text??'').trim();
  const speaker=String(m.speaker??m.agent_name??m.agent??m.role??'').trim().slice(0,100);
  if(!content||content.length>30000||!speaker)throw Object.assign(new Error('Each message needs a speaker and 1–30000 characters of content.'),{status:400});
  const createdAt=m.created_at??m.timestamp??null;
  if(createdAt&&!Number.isFinite(Date.parse(createdAt)))throw Object.assign(new Error('Message timestamps must be valid dates.'),{status:400});
  const metadata=m.metadata&&typeof m.metadata==='object'&&!Array.isArray(m.metadata)?m.metadata:{};
  return {sequence_no:Number.isInteger(m.sequence_no)?m.sequence_no:i,
   round_no:Number.isInteger(m.round_no)&&m.round_no>0?m.round_no:1,
   speaker,agent_key:String(m.agent_key??m.agent_id??'').slice(0,100),
   message_type:String(m.message_type??m.type??'message').slice(0,40),
   content,metadata,created_at:createdAt};
 });
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
   const messages=cleanMessages(input.messages??input.transcript);
   if(!reportText&&!Array.isArray(reportJson.recommendations))return json(res,400,{error:'Provide report_text or structured recommendations.'});
   const runAt=input.run_at??input.runAt??null;
   if(runAt&&!Number.isFinite(Date.parse(runAt)))return json(res,400,{error:'run_at must be a valid ISO date.'});
   const runKey=String(input.run_id??input.runId??randomUUID()).trim().slice(0,160);
   const status=['running','completed','failed'].includes(String(input.status))?String(input.status):'completed';
   const requestedAgents=Number(input.agent_count??input.agentCount??3);
   const agentCount=Number.isInteger(requestedAgents)?Math.max(1,Math.min(12,requestedAgents)):3;
   const admins=await sql.query("SELECT id FROM wealth_users WHERE role='admin' LIMIT 1");
   if(!admins.length)return json(res,409,{error:'No admin account is configured for advisor reports.'});
   const uid=admins[0].id;
   const runs=await sql.query(
    'INSERT INTO wealth_stock_advisor_runs (user_id,run_key,run_at,status,agent_count) VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5) ON CONFLICT (user_id,run_key) DO UPDATE SET run_at=EXCLUDED.run_at,status=EXCLUDED.status,agent_count=EXCLUDED.agent_count RETURNING id,run_key,run_at,status,agent_count',
    [uid,runKey,runAt,status,agentCount]
   );
   const run=runs[0];
   for(const m of messages){
    await sql.query(
     'INSERT INTO wealth_stock_advisor_messages (run_id,sequence_no,round_no,speaker,agent_key,message_type,content,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now())) ON CONFLICT (run_id,sequence_no) DO NOTHING',
     [run.id,m.sequence_no,m.round_no,m.speaker,m.agent_key,m.message_type,m.content,JSON.stringify(m.metadata),m.created_at]
    );
   }
   const saved=await sql.query(
    'INSERT INTO wealth_stock_advisor_reports (user_id,run_id,run_at,report_text,report_json) VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5::jsonb) ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO UPDATE SET run_at=EXCLUDED.run_at,report_text=EXCLUDED.report_text,report_json=EXCLUDED.report_json RETURNING id,run_id,run_at',
    [uid,run.id,runAt,reportText,JSON.stringify(reportJson)]
   );
   const job=await startJob('advisor-ingest');
   await finishJob(job,'succeeded',{runId:run.id,messages:messages.length,reportSaved:saved.length===1});
   const count=await sql.query('SELECT count(*)::int AS count FROM wealth_stock_advisor_messages WHERE run_id=$1',[run.id]);
   return json(res,201,{saved:true,run,report:saved[0],messageCount:count[0]?.count??0});
  }
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const requestedRun=String(new URL(req.url,'https://wealth.local').searchParams.get('run_id')||'').trim();
  const [runs,holdings]=await Promise.all([
   sql.query('SELECT id,run_key,run_at,status,agent_count,created_at FROM wealth_stock_advisor_runs WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 50',[uid]),
   sql.query("SELECT name,ticker,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type='EQUITY' AND currency='INR' ORDER BY name",[uid])
  ]);
  const run=(requestedRun?runs.find(r=>r.id===requestedRun):runs[0])||null;
  let report=null,messages=[];
  if(run){
   const result=await Promise.all([
    sql.query('SELECT id,run_id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 AND run_id=$2 LIMIT 1',[uid,run.id]),
    sql.query('SELECT id,sequence_no,round_no,speaker,agent_key,message_type,content,metadata,created_at FROM wealth_stock_advisor_messages WHERE run_id=$1 ORDER BY sequence_no ASC',[run.id])
   ]);
   report=result[0][0]||null;messages=result[1];
  }else if(!requestedRun){
   report=await latestSavedReport(uid);
  }
  if(requestedRun&&!run)return json(res,404,{error:'Advisor run not found.'});
  return json(res,200,{report,run,runs,messages,holdings});
 }catch(e){
  if(e?.status===400)return json(res,400,{error:e.message});
  console.error('[wealth-stock-advisor]',e?.message||e);
  return json(res,500,{error:'Unable to process Stock Advisor data.'});
 }
}
