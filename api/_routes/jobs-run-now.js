import { sql, json, sessionUser } from '../_lib.js';
import { executeJob } from '../_lib/scheduled-jobs.js';
export default async function handler(req,res) {
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const uid=await sessionUser(req);
  if(!uid)return json(res,401,{error:'Sign in required'});
  const [user]=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  if(user?.role!=='admin')return json(res,403,{error:'Admin only'});
  let raw='';for await(const c of req)raw+=c;
  let body={};try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})}
  const [job]=await sql.query('SELECT * FROM wealth_scheduled_jobs WHERE id=$1',[String(body.id||'')]);
  if(!job)return json(res,404,{error:'Job not found'});
  try{return json(res,200,await executeJob(job,'manual'))}
  catch(error){return json(res,502,{error:String(error?.message||error).slice(0,300)})}
}
