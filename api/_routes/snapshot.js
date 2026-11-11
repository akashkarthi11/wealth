import {sql,schema,json,cachedForUser,sendCached,withStatus} from '../_lib.js';

// GET /api/snapshot — saved records (owner only). Versioned Redis cache (0018): served only while no data has changed.
export default async function handler(req,res){
 try{
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  await schema();
  const r=await cachedForUser(req,'snapshots',async uid=>{
   const [u]=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
   if(!u||u.role!=='admin')return withStatus(403,{error:'Owner admin only'});
   return {snapshots:await sql.query('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid])};
  });
  if(!r.uid)return json(res,401,{error:'Sign in required'});
  return sendCached(res,r);
 }catch(e){console.error('[wealth-snapshot]',e?.message||e);return json(res,500,{error:'Unable to load wealth snapshots.'})}
}
