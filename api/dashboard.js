import {sql,schema,json,userFrom,cacheGet,cacheSet,scheduleCacheRefresh} from './_lib.js';

async function readPositions(uid){
 const enrichedQuery=`SELECT p.id,p.category,p.institution_name,p.platform_name,p.record_type,p.name,p.ticker,p.currency,p.quantity,
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND a.id IS NOT NULL AND p.quantity IS NOT NULL THEN p.quantity*mp.unit_price ELSE p.current_value END AS current_value,
  p.invested_value,p.balance_as_of,p.source_key,p.metadata,mp.unit_price AS market_unit_price,mp.currency AS market_price_currency,
  mp.source AS market_price_source,mp.fetched_at AS market_price_updated_at,mp.status AS market_price_status,a.quantity_unit,
  (mp.metadata->>'fx_to_inr')::numeric AS market_fx_to_inr,
  CASE WHEN mp.status='fresh' AND mp.fetched_at>now()-interval '36 hours' AND p.quantity IS NOT NULL
   THEN CASE WHEN mp.currency='USD' THEN p.quantity*mp.unit_price*NULLIF((mp.metadata->>'fx_to_inr')::numeric,0)
             WHEN mp.currency='INR' THEN p.quantity*mp.unit_price ELSE NULL END ELSE NULL END AS market_value_inr
  FROM wealth_positions p
  LEFT JOIN wealth_investment_assets a ON a.position_id=p.id
  LEFT JOIN wealth_market_prices mp ON mp.asset_id=a.id
  WHERE p.user_id=$1 ORDER BY p.category,p.platform_name,p.record_type,p.name`;
 try{
  return await sql.query(enrichedQuery,[uid]);
 }catch(error){
  console.error('[wealth-dashboard:priced-positions]',error?.message||error);
  // A missing pricing table must never hide the user's saved positions or turn totals into zero.
  return await sql.query(`SELECT id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,
   current_value,invested_value,balance_as_of,source_key,metadata,
   NULL::numeric AS market_unit_price,NULL::char(3) AS market_price_currency,
   NULL::text AS market_price_source,NULL::timestamptz AS market_price_updated_at,
   NULL::text AS market_price_status,NULL::text AS quantity_unit,
   NULL::numeric AS market_fx_to_inr,NULL::numeric AS market_value_inr
   FROM wealth_positions WHERE user_id=$1
   ORDER BY category,platform_name,record_type,name`,[uid]);
 }
}
async function readDashboard(uid){
 const [users,transactions,templates,accounts,positions]=await Promise.all([
  sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
  sql.query("SELECT t.id,t.kind,t.category,t.description,t.amount,t.account_id,COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,t.occurred_on FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 500",[uid]),
  sql.query("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
  sql.query("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
  readPositions(uid)
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
  // Self-heal the category-symbol table on databases where the app code was deployed before its DB migration.
  await sql.query(\`CREATE TABLE IF NOT EXISTS wealth_category_symbols (
    user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
    category_key text NOT NULL,
    display_symbol text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,category_key),
    CONSTRAINT wealth_category_symbols_nonempty CHECK (length(trim(display_symbol)) BETWEEN 1 AND 16)
  )\`);
  const symbolRows=await sql.query('SELECT category_key,display_symbol FROM wealth_category_symbols WHERE user_id=$1',[uid]).catch(e=>{console.warn('[wealth-dashboard:symbols]',e?.message||e);return []});
  const categorySymbols=Object.fromEntries(symbolRows.map(r=>[r.category_key,r.display_symbol]));
  const key='wealth:dashboard:v2:'+uid;
  const cached=await cacheGet(key);
  if(cached){
   try{
    const payload=typeof cached==='string'?JSON.parse(cached):cached;
    if(payload&&Array.isArray(payload.transactions)&&Array.isArray(payload.accounts)&&Array.isArray(payload.positions)){
     // Return cached data immediately; refresh from Neon asynchronously via waitUntil().
     scheduleCacheRefresh(uid,'dashboard',async()=>{const fresh=await readDashboard(uid);if(fresh)await cacheSet(key,fresh,120)},120);
     return json(res,200,{transactions:payload.transactions,snapshots:payload.snapshots||[],template:payload.template||null,accounts:payload.accounts,positions:payload.positions,categorySymbols});
    }
   }catch(e){console.warn('[wealth-dashboard:cache-invalid]',e?.message||e)}
  }
  const payload=await readDashboard(uid);
  if(!payload)return json(res,401,{error:'Sign in required'});
  await cacheSet(key,payload,120);
  return json(res,200,{transactions:payload.transactions,snapshots:payload.snapshots,template:payload.template,accounts:payload.accounts,positions:payload.positions,categorySymbols});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
