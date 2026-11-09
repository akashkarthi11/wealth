import {sql,schema,json,userFrom,cacheSet} from './_lib.js';
async function readDashboard(uid){
 const [users,transactions,templates,accounts,positions]=await Promise.all([
  sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
  sql.query("SELECT t.id,t.kind,t.category,t.description,t.amount,t.account_id,COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,t.occurred_on FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 500",[uid]),
  sql.query("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
  sql.query("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
  sql.query("SELECT id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,source_key,metadata FROM wealth_positions WHERE user_id=$1 ORDER BY category,platform_name,record_type,name",[uid]).catch(()=>[])
 ]);
 if(!users.length)return null;
 const role=users[0].role;
 const snapshots=role==='admin'?await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]):[];
 return {role,transactions,snapshots,template:templates[0]?.config||null,accounts,positions};
}
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  // Neon tables are the source of truth. Redis is write-through cache only;
  // never serve an older cached dashboard as current financial data.
  const payload=await readDashboard(uid);
  if(!payload)return json(res,401,{error:'Sign in required'});
  await cacheSet('wealth:dashboard:v2:'+uid,payload,120);
  return json(res,200,{transactions:payload.transactions,snapshots:payload.snapshots,template:payload.template,accounts:payload.accounts,positions:payload.positions});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
