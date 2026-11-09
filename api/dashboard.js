import {sql,schema,json,userFrom,cacheGet,cacheSet} from './_lib.js';
const dashboardKey=uid=>'wealth:dashboard:v2:'+uid;
function unpack(value){if(!value)return null;try{let x=typeof value==='string'?JSON.parse(value):value;if(typeof x==='string')x=JSON.parse(x);return x}catch{return null}}
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  // One Redis read serves the whole dashboard: role, ledger and saved snapshots.
  const cached=unpack(await cacheGet(dashboardKey(uid)));
  if(cached&&cached.role&&cached.template&&Array.isArray(cached.transactions)&&Array.isArray(cached.snapshots)&&Array.isArray(cached.accounts)&&Array.isArray(cached.positions)) {
   return json(res,200,{transactions:cached.transactions,snapshots:cached.snapshots,template:cached.template,accounts:cached.accounts,positions:cached.positions});
  }
  // Cache miss: fetch all required data concurrently from Neon.
  const [users,transactions,templates,accounts,positions]=await Promise.all([
   sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
   sql.query("SELECT t.id,t.kind,t.category,t.description,t.amount,t.account_id,COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,t.occurred_on FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 500",[uid]),
   sql.query("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
   sql.query("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
   sql.query("SELECT id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,source_key,metadata FROM wealth_positions WHERE user_id=$1 ORDER BY category,platform_name,record_type,name",[uid]).catch(()=>[])
  ]);
  if(!users.length)return json(res,401,{error:'Sign in required'});
  const role=users[0].role;
  const snapshots=role==='admin'
   ?await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid])
   :[];
  const template=templates[0]?.config||null;
  const payload={role,transactions,snapshots,template,accounts,positions};
  await cacheSet(dashboardKey(uid),payload,15);
  return json(res,200,{transactions,snapshots,template,accounts,positions});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
