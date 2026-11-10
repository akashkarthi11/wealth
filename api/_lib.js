import { neon } from '@neondatabase/serverless';
import { createClient } from 'redis';
import { waitUntil } from '@vercel/functions';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const dbUrl=process.env.POSTGRES_URL || process.env.WEALTH_DATABASE_URL || process.env.DATABASE_URL;
export const sql=dbUrl ? neon(dbUrl) : null;

// Vercel Redis integration provides REDIS_URL. Keep caching optional so Neon remains the source of truth.
// Redis must never block a request: every operation has a hard time limit, a connection that cannot be
// made stops retrying, and after a failure Redis is skipped for a cool-down period (fail open).
const redisUrl=process.env.REDIS_URL;
const REDIS_OP_MS=Number(process.env.REDIS_OP_TIMEOUT_MS||1000);
const REDIS_COOLDOWN_MS=30000;
let redisClient=null,redisConnectPromise=null,redisDownUntil=0;
function newRedisClient(){
 const c=createClient({url:redisUrl,socket:{connectTimeout:REDIS_OP_MS,reconnectStrategy:retries=>retries>=1?new Error('Redis unavailable'):100}});
 c.on('error',e=>console.warn('[wealth-cache:redis]',e?.message||e));
 return c;
}
function withTimeout(promise,ms,what){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(what+' timed out after '+ms+' ms')),ms)})]).finally(()=>clearTimeout(timer));
}
function markRedisDown(e){
 redisDownUntil=Date.now()+REDIS_COOLDOWN_MS;
 const c=redisClient;redisClient=null;redisConnectPromise=null;
 if(c)c.disconnect().catch(()=>{});
 console.warn('[wealth-cache:redis-down]',e?.message||e);
}
async function getRedis(){
 if(!redisUrl||Date.now()<redisDownUntil)return null;
 if(!redisClient)redisClient=newRedisClient();
 if(!redisClient.isReady){
  if(!redisConnectPromise)redisConnectPromise=redisClient.connect();
  await withTimeout(redisConnectPromise,REDIS_OP_MS,'Redis connect');
 }
 return redisClient;
}
// Run one Redis operation; on any error or timeout, return the fallback and skip Redis for a while.
export async function redisOp(op,fallback,label='op'){
 try{
  const client=await getRedis();
  if(!client)return fallback;
  return await withTimeout(op(client),REDIS_OP_MS,'Redis '+label);
 }catch(e){markRedisDown(e);return fallback}
}
export async function cacheGet(key){return redisOp(c=>c.get(key),null,'get')}
export async function cacheSet(key,value,ttl=20){await redisOp(c=>c.set(key,JSON.stringify(value),{EX:ttl}),null,'set')}
export async function cacheLock(key,ttl=10){return redisOp(async c=>(await c.set(key,'1',{EX:ttl,NX:true}))==='OK',false,'lock')}
export async function cacheDel(...keys){if(keys.length)await redisOp(c=>c.del(keys),null,'del')}
export async function invalidateUserCaches(uid){
 await cacheDel('wealth:ledger:v1:'+uid,'wealth:ledger:v2:'+uid,'wealth:dashboard:v1:'+uid,'wealth:dashboard:v2:'+uid,'wealth:dashboard:v3:'+uid,'wealth:dashboard:v4:'+uid,'wealth:dashboard:v5:'+uid,'wealth:snapshots:v2:'+uid);
}
// Data model switch (TSD §13): 'v1' legacy positions (default) or 'v2' account hierarchy.
export function dataModel(){return String(process.env.WEALTH_DATA_MODEL||'v1').trim().toLowerCase()==='v2'?'v2':'v1'}
// Database schema is provisioned by migrations, never by request handlers.
// Avoid running DDL and role UPDATE statements on every serverless cold start.
export async function schema(){
 if(!sql) throw new Error('WEALTH_DATABASE_URL is not configured');
}
export function hash(p){const s=randomBytes(16);return 's1$'+s.toString('base64url')+'$'+scryptSync(p,s,64).toString('base64url')}
export function check(p,h){try{const [v,s,x]=h.split('$');if(v!=='s1')return false;const a=Buffer.from(x,'base64url'),b=scryptSync(p,Buffer.from(s,'base64url'),a.length);return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}}

// Password policy (TR-1.2). Login only enforces the maximum so older short passwords still work.
export const PASSWORD_MIN=10,PASSWORD_MAX=200;
export function passwordProblem(p){
 const s=String(p??'');
 if(s.length<PASSWORD_MIN)return 'Password must be at least '+PASSWORD_MIN+' characters.';
 if(s.length>PASSWORD_MAX)return 'Password is too long.';
 return null;
}

// Constant-time comparison for shared secrets (TR-1.5).
export function safeEqual(a,b){
 const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));
 if(x.length!==y.length||x.length===0)return false;
 return timingSafeEqual(x,y);
}

const secret=()=>process.env.WEALTH_SESSION_SECRET||'';
// Session token = base64url({uid, exp, sv}) + '.' + HMAC. `sv` is the user's session_version (TR-1.4);
// bumping it in the database invalidates every cookie issued before.
export function token(uid,sv=1){if(secret().length<32)throw new Error('WEALTH_SESSION_SECRET must be at least 32 characters');const body=Buffer.from(JSON.stringify({uid,exp:Date.now()+7*864e5,sv:Number(sv)||1})).toString('base64url');return body+'.'+createHmac('sha256',secret()).update(body).digest('base64url')}
export function sessionFrom(req){try{const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('wealth_session='));if(!c)return null;const [b,s]=c.slice(15).split('.');const sig=createHmac('sha256',secret()).update(b).digest();const got=Buffer.from(s||'','base64url');if(sig.length!==got.length||!timingSafeEqual(sig,got))return null;const p=JSON.parse(Buffer.from(b,'base64url'));return p.exp>Date.now()&&p.uid?{uid:p.uid,sv:Number(p.sv)||1}:null}catch{return null}}
// Signature + expiry only. Use sessionUser() wherever a revoked session must be rejected.
export function userFrom(req){return sessionFrom(req)?.uid||null}
// Signature + expiry + session_version check against the database.
export async function sessionUser(req){
 const s=sessionFrom(req);
 if(!s||!sql)return null;
 try{
  const rows=await sql.query('SELECT session_version FROM wealth_users WHERE id=$1',[s.uid]);
  if(!rows.length)return null;
  return Number(rows[0].session_version||1)===s.sv?s.uid:null;
 }catch(e){
  // Column not migrated yet (42703): fall back to signature-only so a code deploy cannot lock everyone out.
  if(e?.code==='42703')return s.uid;
  throw e;
 }
}

// Fixed-window rate limit backed by Redis (TR-1.3). Fails open when Redis is unavailable.
export async function rateLimit(key,limit,windowSec){
 const k='wealth:rl:'+key;
 return redisOp(async client=>{
  const n=await client.incr(k);
  if(n===1)await client.expire(k,windowSec);
  if(n>limit){const ttl=await client.ttl(k);return {allowed:false,retryAfter:ttl>0?ttl:windowSec}}
  return {allowed:true,retryAfter:0};
 },{allowed:true,retryAfter:0},'ratelimit');
}
export async function rateCount(key){
 return redisOp(async client=>Number(await client.get('wealth:rl:'+key)||0),0,'ratecount');
}
export async function rateReset(key){await cacheDel('wealth:rl:'+key)}
export function clientIp(req){return String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket?.remoteAddress||'unknown'}
export function cookie(res,v){res.setHeader('Set-Cookie',v?'wealth_session='+v+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800':'wealth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')}
export function json(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))}
export async function body(req){let s='';for await(const c of req)s+=c;if(s.length>20000)throw new Error('Request too large');return JSON.parse(s||'{}')}


// Schedule stale-while-revalidate work within the current Vercel Function lifetime.
// The Redis lock is a cooldown (not released on success), preventing refresh storms.
export function scheduleCacheRefresh(uid,resource,refresh,ttl){
 if(!uid||typeof refresh!=='function')return;
 const lockKey='wealth:refresh-lock:v1:'+uid+':'+resource;
 waitUntil((async()=>{
  const locked=await cacheLock(lockKey,ttl);
  if(!locked)return;
  try{await refresh()}
  catch(e){
   console.warn('[wealth-cache:refresh]',resource,e?.message||e);
   await cacheDel(lockKey);
  }
 })());
}
