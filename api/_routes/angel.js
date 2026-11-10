import { createHmac, createHash } from 'node:crypto';
import { sql, schema, json, sessionUser } from '../_lib.js';

const BASE='https://apiconnect.angelone.in';
const b32=s=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of String(s||'').toUpperCase().replace(/=|\s/g,'')){const n=alphabet.indexOf(c);if(n<0)throw new Error('Invalid ANGEL_TOTP_SECRET');bits+=n.toString(2).padStart(5,'0')}const out=[];for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out)};
function totp(secret){const key=b32(secret),counter=BigInt(Math.floor(Date.now()/30000)),buf=Buffer.alloc(8);buf.writeBigUInt64BE(counter);const h=createHmac('sha1',key).update(buf).digest(),o=h[h.length-1]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0')}
const headers=(key,mac)=>({'Content-Type':'application/json','Accept':'application/json','X-PrivateKey':key,'X-MACAddress':mac,'X-UserType':'USER','X-SourceID':'WEB'});
async function call(path,opts){const r=await fetch(BASE+path,opts);const data=await r.json().catch(()=>({}));if(!r.ok||data.status===false)throw new Error(data.message||'Angel One API request failed ('+r.status+')');return data.data}
export default async function handler(req,res){
 try{
  await schema();const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const u=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);if(!u.length||u[0].role!=='admin')return json(res,403,{error:'Owner admin only'});
  if(req.method!=='GET')return json(res,405,{error:'Read-only endpoint'});
  const names=['ANGEL_API_KEY','ANGEL_CLIENT_CODE','ANGEL_PIN','ANGEL_TOTP_SECRET','ANGEL_MAC_ADDRESS'];
  const missing=names.filter(k=>!process.env[k]);
  if(missing.length)return json(res,200,{connected:false,provider:'Angel One SmartAPI',mode:'read-only',missing,setupRequired:true});
  const key=process.env.ANGEL_API_KEY,mac=process.env.ANGEL_MAC_ADDRESS;
  const auth=await call('/rest/auth/angelbroking/user/v1/loginByPassword',{method:'POST',headers:headers(key,mac),body:JSON.stringify({clientcode:process.env.ANGEL_CLIENT_CODE,password:process.env.ANGEL_PIN,totp:totp(process.env.ANGEL_TOTP_SECRET)})});
  if(!auth?.jwtToken)throw new Error('Angel One login did not return an access token');
  const h={...headers(key,mac),Authorization:'Bearer '+auth.jwtToken};
  const [holdings,rms,positions]=await Promise.all([
   call('/rest/secure/angelbroking/portfolio/v1/getAllHolding',{method:'GET',headers:h}),
   call('/rest/secure/angelbroking/user/v1/getRMS',{method:'GET',headers:h}),
   call('/rest/secure/angelbroking/order/v1/getPosition',{method:'GET',headers:h})
  ]);
  return json(res,200,{connected:true,provider:'Angel One SmartAPI',mode:'read-only',fetchedAt:new Date().toISOString(),holdings,rms,positions});
 }catch(e){console.error('[wealth-angel-readonly]',e?.message||e);return json(res,502,{connected:false,error:e?.message||'Angel One connection failed'})}
}
