import {sql,schema,json,userFrom,cacheGet,cacheSet} from './_lib.js';
const ledgerKey=uid=>'wealth:ledger:v1:'+uid;
const snapshotKey=uid=>'wealth:snapshots:v2:'+uid;
function unpack(value){if(!value)return null;try{let x=typeof value==='string'?JSON.parse(value):value;if(typeof x==='string')x=JSON.parse(x);return x}catch{return null}}
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  const [users,ledgerCache,snapshotCache]=await Promise.all([
   sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]),
   cacheGet(ledgerKey(uid)),
   cacheGet(snapshotKey(uid))
  ]);
  if(!users.length)return json(res,401,{error:'Sign in required'});
  const admin=users[0].role==='admin';
  const cachedLedger=unpack(ledgerCache),cachedSnapshot=admin?unpack(snapshotCache):null;
  const ledgerPromise=cachedLedger&&Array.isArray(cachedLedger.transactions)
   ?Promise.resolve(cachedLedger.transactions)
   :sql.query('SELECT id,kind,category,description,amount,account,occurred_on FROM wealth_transactions WHERE user_id=$1 ORDER BY occurred_on DESC,created_at DESC LIMIT 500',[uid]);
  const snapshotPromise=!admin?Promise.resolve([]):(cachedSnapshot&&Array.isArray(cachedSnapshot.snapshots)
   ?Promise.resolve(cachedSnapshot.snapshots)
   :sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]));
  const [transactions,snapshots]=await Promise.all([ledgerPromise,snapshotPromise]);
  const jobs=[];
  if(!(cachedLedger&&Array.isArray(cachedLedger.transactions)))jobs.push(cacheSet(ledgerKey(uid),{transactions},20));
  if(admin&&!(cachedSnapshot&&Array.isArray(cachedSnapshot.snapshots)))jobs.push(cacheSet(snapshotKey(uid),{snapshots},60));
  await Promise.all(jobs);
  return json(res,200,{transactions,snapshots});
 }catch(e){console.error('[wealth-dashboard]',e?.message||e);return json(res,500,{error:'Unable to load dashboard.'})}
}
