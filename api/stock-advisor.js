import {sql,schema,json,userFrom} from './_lib.js';

export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  const [reports,holdings]=await Promise.all([
   sql.query('SELECT id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 1',[uid]),
   sql.query("SELECT name,ticker,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type='EQUITY' AND currency='INR' ORDER BY name",[uid])
  ]);
  return json(res,200,{report:reports[0]||null,holdings});
 }catch(e){console.error('[wealth-stock-advisor]',e?.message||e);return json(res,500,{error:'Unable to load Stock Advisor data.'})}
}
