import {sql,schema,json,userFrom} from './_lib.js';

export default async function handler(req,res){
 try{
  await schema();
  const uid=userFrom(req);
  if(!uid)return json(res,401,{error:'Sign in required'});
  const users=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  if(!users.length||users[0].role!=='admin')return json(res,403,{error:'Owner admin only'});
  if(req.method==='GET'){
   // Neon is the source of truth. Read persisted snapshots directly; do not serve stale Redis cache copies.
   const rows=await sql.query(
    'SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',
    [uid]
   );
   return json(res,200,{snapshots:rows});
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){
  console.error('[wealth-snapshot]',e?.message||e);
  return json(res,500,{error:'Unable to load wealth snapshots.'});
 }
}
