import { neon } from '@neondatabase/serverless';
import { createClient } from 'redis';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const dbUrl=process.env.POSTGRES_URL || process.env.WEALTH_DATABASE_URL || process.env.DATABASE_URL;
export const sql=dbUrl ? neon(dbUrl) : null;

// Vercel Redis integration provides REDIS_URL. Keep caching optional so Neon remains the source of truth.
const redisUrl=process.env.REDIS_URL;
const redisClient=redisUrl ? createClient({url:redisUrl}) : null;
let redisConnectPromise=null;
if(redisClient){
 redisClient.on('error',e=>console.warn('[wealth-cache:redis]',e?.message||e));
}
async function getRedis(){
 if(!redisClient)return null;
 if(!redisClient.isOpen){
  if(!redisConnectPromise){
   redisConnectPromise=redisClient.connect().catch(e=>{
    redisConnectPromise=null;
    throw e;
   });
  }
  await redisConnectPromise;
 }
 return redisClient;
}
export async function cacheGet(key){
 try{const client=await getRedis();return client?await client.get(key):null}
 catch(e){console.warn('[wealth-cache:get]',e?.message||e);return null}
}
export async function cacheSet(key,value,ttl=20){
 try{const client=await getRedis();if(client)await client.set(key,JSON.stringify(value),{EX:ttl})}
 catch(e){console.warn('[wealth-cache:set]',e?.message||e)}
}
export async function cacheDel(...keys){
 try{const client=await getRedis();if(client&&keys.length)await client.del(keys)}
 catch(e){console.warn('[wealth-cache:del]',e?.message||e)}
}
export async function invalidateUserCaches(uid){
 await cacheDel('wealth:ledger:v1:'+uid,'wealth:dashboard:v1:'+uid);
}
// Database schema is provisioned by migrations, never by request handlers.
// Avoid running DDL and role UPDATE statements on every serverless cold start.
export async function schema(){
 if(!sql) throw new Error('WEALTH_DATABASE_URL is not configured');
}
export function hash(p){const s=randomBytes(16);return 's1$'+s.toString('base64url')+'$'+scryptSync(p,s,64).toString('base64url')}
export function check(p,h){try{const [v,s,x]=h.split('$');if(v!=='s1')return false;const a=Buffer.from(x,'base64url'),b=scryptSync(p,Buffer.from(s,'base64url'),a.length);return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}}
const secret=()=>process.env.WEALTH_SESSION_SECRET||'';
export function token(uid){if(secret().length<32)throw new Error('WEALTH_SESSION_SECRET must be at least 32 characters');const body=Buffer.from(JSON.stringify({uid,exp:Date.now()+7*864e5})).toString('base64url');return body+'.'+createHmac('sha256',secret()).update(body).digest('base64url')}
export function userFrom(req){try{const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('wealth_session='));if(!c)return null;const [b,s]=c.slice(15).split('.');const sig=createHmac('sha256',secret()).update(b).digest();const got=Buffer.from(s,'base64url');if(sig.length!==got.length||!timingSafeEqual(sig,got))return null;const p=JSON.parse(Buffer.from(b,'base64url'));return p.exp>Date.now()?p.uid:null}catch{return null}}
export function cookie(res,v){res.setHeader('Set-Cookie',v?'wealth_session='+v+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800':'wealth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')}
export function json(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))}
export async function body(req){let s='';for await(const c of req)s+=c;if(s.length>20000)throw new Error('Request too large');return JSON.parse(s||'{}')}
