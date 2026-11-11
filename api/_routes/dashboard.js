import {sql,schema,json,dashboardModel,cachedForUser,sendCached,withStatus} from '../_lib.js';
import {pageTransactions,spendingRows,accountHierarchyRows,legacyPositionRows} from '../_queries.js';
import {valuePortfolio} from '../_valuation.js';
import {brokerSummary} from '../_broker.js';
import {rewardsOverview} from '../_rewards.js';

const warn=label=>e=>{console.warn('[wealth-dashboard:'+label+']',e?.message||e);return null};

// Every query runs at the same time (one round of database round trips instead of several in sequence).
// Owner-only parts (saved records, rewards) are fetched in parallel and dropped for other roles.
async function buildDashboard(uid,asked){
 const defaultV2=dashboardModel()==='v2';
 const mayNeedV2=asked==='v1'?true:asked==='v2'||defaultV2;     // v1 only applies to the owner; fetch v2 in case
 const [users,page,spending,templates,accounts,positions,interest,interestStatements,snapshots,symbolRows,hierarchy,broker,rewards]=await Promise.all([
  sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
  pageTransactions(uid),
  spendingRows(uid),
  sql.query("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
  sql.query("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
  legacyPositionRows(uid),
  sql.query('SELECT id,provider,product_key,account_key,partition_key,accrual_date,principal,annual_rate,day_count,interest_amount,entry_type,revision,source_url,calculation_status,transaction_id,notes FROM wealth_interest_ledger WHERE user_id=$1 ORDER BY accrual_date DESC,created_at DESC LIMIT 500',[uid]).catch(e=>warn('interest')(e)||[]),
  sql.query('SELECT id,provider,product_key,period_start,period_end,statement_total,currency,statement_label,daily_breakdown,source_type,source_files,captured_at,notes FROM wealth_interest_statements WHERE user_id=$1 ORDER BY period_start DESC,product_key',[uid]).catch(e=>warn('interest-statements')(e)||[]),
  sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]),
  sql.query('SELECT category_key,display_symbol FROM wealth_category_symbols WHERE user_id=$1',[uid]).catch(e=>warn('symbols')(e)||[]),
  mayNeedV2?accountHierarchyRows(uid).catch(e=>({error:e})):null,
  // Broker funds ledger (0011) and rewards (0014): never block the dashboard.
  brokerSummary(uid).catch(e=>warn('broker')(e)||[]),
  rewardsOverview(uid).catch(warn('rewards')),
 ]);
 if(!users.length)return null;
 const admin=users[0].role==='admin';
 // Account hierarchy (v2) is the default dashboard; the owner can compare with ?model=v1 (or ?model=v2 when the default is v1).
 const wantV2=admin&&asked==='v1'?false:admin&&asked==='v2'?true:defaultV2;
 let model=null;
 if(wantV2){
  if(!hierarchy||hierarchy.error){console.error('[wealth-dashboard:v2]',hierarchy?.error?.message||'not loaded');model={version:'v2',error:'Account model is not available yet.'}}
  else{try{model={version:'v2',generatedAt:new Date().toISOString(),...valuePortfolio(hierarchy)}}catch(e){console.error('[wealth-dashboard:v2]',e?.message||e);model={version:'v2',error:'Account model is not available yet.'}}}
 }
 return {broker,rewards:admin?rewards:null,transactions:page.transactions,nextCursor:page.nextCursor,spending:spending,snapshots:admin?snapshots:[],
  template:templates[0]?.config||null,accounts,positions,interest,interestStatements,categorySymbols:Object.fromEntries(symbolRows.map(r=>[r.category_key,r.display_symbol])),model};
}

// GET /api/dashboard — cached in Redis by data version (0018): served from the cache only while no data has changed
// since it was built (any writer bumps the version), so balances are never stale. The cache key also carries the IST day
// so day-based figures (month to date, "today") roll over at midnight.
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  await schema();
  const asked=new URL(req.url,'https://local').searchParams.get('model')||'';
  const day=new Date(Date.now()+5.5*3600e3).toISOString().slice(0,10);
  const r=await cachedForUser(req,'dashboard',async uid=>(await buildDashboard(uid,asked))||withStatus(401,{error:'Sign in required'}),{variant:[asked||'default',dashboardModel(),day].join(':'),ttl:600});
  if(!r.uid)return json(res,401,{error:'Sign in required'});
  return sendCached(res,r);
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
