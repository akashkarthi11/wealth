import {sql,schema,json,userFrom,cacheGet,cacheSet} from './_lib.js';
const dashboardKey=uid=>'wealth:dashboard:v1:'+uid;
function unpack(value){if(!value)return null;try{let x=typeof value==='string'?JSON.parse(value):value;if(typeof x==='string')x=JSON.parse(x);return x}catch{return null}}
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  // One Redis read serves the whole dashboard: role, ledger and saved snapshots.
  const cached=unpack(await cacheGet(dashboardKey(uid)));
  if(cached&&cached.role&&Array.isArray(cached.transactions)&&Array.isArray(cached.snapshots)){
   return json(res,200,{transactions:cached.transactions,snapshots:cached.snapshots});
  }
  // Cache miss: fetch all required data concurrently from Neon.
  const [users,transactions]=await Promise.all([
   sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
   sql.query('SELECT id,kind,category,description,amount,account,occurred_on FROM wealth_transactions WHERE user_id=$1 ORDER BY occurred_on DESC,created_at DESC LIMIT 500',[uid])
  ]);
  if(!users.length)return json(res,401,{error:'Sign in required'});
  const role=users[0].role;
  const snapshots=role==='admin'
   ?await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid])
   :[];
  const payload={role,transactions,snapshots};
  await cacheSet(dashboardKey(uid),payload,15);
  return json(res,200,{transactions,snapshots});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
