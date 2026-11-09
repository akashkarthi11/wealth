import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
import { json, userFrom, body } from './_lib.js';

const db = process.env.WEALTH_INGESTION_DATABASE_URL ? neon(process.env.WEALTH_INGESTION_DATABASE_URL) : null;
export default async function handler(req,res){
 try{
  const uid=userFrom(req); if(!uid)return json(res,401,{error:'Sign in required'});
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(process.env.WEALTH_INGESTION_ENABLED!=='true'||!db)return json(res,503,{error:'Ingestion is disabled until the isolated test database is configured.'});
  const b=await body(req); const label=String(b.label||'Android device').slice(0,60);
  const token='wlt_'+randomBytes(32).toString('base64url');
  const hash=createHash('sha256').update(token).digest('hex');
  await db.query('INSERT INTO wealth_ingestion_tokens(user_id,token_hash,label) VALUES($1,$2,$3)',[uid,hash,label]);
  return json(res,201,{token,warning:'Shown once. Store only in Android Keystore; never share it.'});
 }catch(e){console.error('[wealth-ingestion-token]',e?.message||e);return json(res,500,{error:'Unable to create device token.'})}
}
