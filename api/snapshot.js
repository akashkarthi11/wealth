import {sql,schema,json,userFrom,cacheGet,cacheSet,enqueueCacheRefresh} from './_lib.js';
export default async function handler(req,res){
 try{
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});await schema();
  const users=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  if(!users.length||users[0].role!=='admin')return json(res,403,{error:'Owner admin only'});
  if(req.method==='GET'){
   const key='wealth:snapshots:v2:'+uid;const cached=await cacheGet(key);
   if(cached){try{const data=typeof cached==='string'?JSON.parse(cached):cached;if(data&&Array.isArray(data.snapshots)){await enqueueCacheRefresh(uid,'snapshots');return json(res,200,data)}}catch(e){console.warn('[wealth-snapshot:cache-invalid]',e?.message||e)}}
   const rows=await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]);
   const data={snapshots:rows};await cacheSet(key,data,60);return json(res,200,data);
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){console.error('[wealth-snapshot]',e?.message||e);return json(res,500,{error:'Unable to load wealth snapshots.'})}
}
