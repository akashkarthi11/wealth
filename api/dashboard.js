import {sql,schema,json,sessionUser,dataModel} from './_lib.js';
import {pageTransactions,spendingRows,accountHierarchyRows,legacyPositionRows} from './_queries.js';
import {valuePortfolio} from './_valuation.js';

async function readDashboard(uid){
 const [users,page,spending,templates,accounts,positions,interest,interestStatements]=await Promise.all([
  sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
  pageTransactions(uid),
  spendingRows(uid),
  sql.query("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
  sql.query("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
  legacyPositionRows(uid),
  sql.query('SELECT id,provider,product_key,account_key,partition_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,revision,source_url,calculation_status,transaction_id,notes FROM wealth_interest_ledger WHERE user_id=$1 ORDER BY accrual_date DESC,created_at DESC LIMIT 500',[uid]).catch(e=>{console.warn('[wealth-dashboard:interest]',e?.message||e);return []}),
  sql.query('SELECT id,provider,product_key,period_start,period_end,statement_total,currency,statement_label,daily_breakdown,source_type,source_files,captured_at,notes FROM wealth_interest_statements WHERE user_id=$1 ORDER BY period_start DESC,product_key',[uid]).catch(e=>{console.warn('[wealth-dashboard:interest-statements]',e?.message||e);return []})
 ]);
 if(!users.length)return null;
 const role=users[0].role;
 const snapshots=role==='admin'?await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]):[];
 return {role,transactions:page.transactions,nextCursor:page.nextCursor,spending,snapshots,template:templates[0]?.config||null,accounts,positions,interest,interestStatements};
}
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  // Schema is created by scripts/migrate-db.mjs (0000_baseline); request handlers never run DDL (TR-2.5).
  const symbolRows=await sql.query('SELECT category_key,display_symbol FROM wealth_category_symbols WHERE user_id=$1',[uid]).catch(e=>{console.warn('[wealth-dashboard:symbols]',e?.message||e);return []});
  const categorySymbols=Object.fromEntries(symbolRows.map(r=>[r.category_key,r.display_symbol]));
  // Financial balances must never be served stale from Redis. A stale-while-revalidate
  // response can temporarily omit a newly added holding (or retain a deleted one),
  // making category totals disagree with the holdings list. Read the current DB rows
  // for every dashboard request; keep cache invalidation for other resources separate.
  const payload=await readDashboard(uid);
  if(!payload)return json(res,401,{error:'Sign in required'});
  // Account hierarchy (v2): on when WEALTH_DATA_MODEL=v2, or for the owner with ?model=v2 to compare before switching.
  const wantV2=dataModel()==='v2'||(payload.role==='admin'&&new URL(req.url,'https://local').searchParams.get('model')==='v2');
  let model=null;
  if(wantV2){
   try{model={version:'v2',generatedAt:new Date().toISOString(),...valuePortfolio(await accountHierarchyRows(uid))}}
   catch(e){console.error('[wealth-dashboard:v2]',e?.message||e);model={version:'v2',error:'Account model is not available yet.'}}
  }
  return json(res,200,{transactions:payload.transactions,nextCursor:payload.nextCursor,spending:payload.spending,snapshots:payload.snapshots,template:payload.template,accounts:payload.accounts,positions:payload.positions,interest:payload.interest,interestStatements:payload.interestStatements,categorySymbols,model});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
