import {sql,schema,json,userFrom,body} from './_lib.js';
import {timingSafeEqual} from 'node:crypto';

function validIngestSecret(req){
 const expected=process.env.WEALTH_ADVISOR_INGEST_SECRET||'';
 const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(expected.length<32||supplied.length!==expected.length)return false;
 try{return timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))}catch{return false}
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
   const saved=await sql.query(
    'INSERT INTO wealth_stock_advisor_reports (user_id,run_at,report_text,report_json) VALUES ($1,COALESCE($2::timestamptz,now()),$3,$4::jsonb) RETURNING id,run_at',
    [admins[0].id,runAt,reportText,JSON.stringify(reportJson)]
   );
   return json(res,201,{saved:true,report:saved[0]});
  }
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const [reports,holdings]=await Promise.all([
   sql.query('SELECT id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 1',[uid]),
   sql.query("SELECT name,ticker,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type='EQUITY' AND currency='INR' ORDER BY name",[uid])
  ]);
  return json(res,200,{report:reports[0]||null,holdings});
 }catch(e){console.error('[wealth-stock-advisor]',e?.message||e);return json(res,500,{error:'Unable to process Stock Advisor data.'})}
}
