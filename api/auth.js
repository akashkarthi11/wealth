import {sql,schema,hash,check,token,cookie,json,body,sessionUser,passwordProblem,PASSWORD_MAX,safeEqual,rateLimit,rateCount,rateReset,clientIp} from './_lib.js';

const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const accessAllowed = supplied => safeEqual(supplied, process.env.WEALTH_ACCESS_KEY || '');
const WINDOW = 15 * 60;          // seconds
const EMAIL_LIMIT = 5, IP_LIMIT = 20;

// session_version may not exist until migration 0001 is applied; fall back to version 1.
async function findUserByEmail(email){
 try { return (await sql.query('SELECT id,email,password_hash,role,session_version FROM wealth_users WHERE email=$1',[email]))[0]||null; }
 catch(e){ if(e?.code!=='42703')throw e; const r=(await sql.query('SELECT id,email,password_hash,role FROM wealth_users WHERE email=$1',[email]))[0]; return r?{...r,session_version:1}:null; }
}
async function setPassword(email,newHash){
 try { return (await sql.query('UPDATE wealth_users SET password_hash=$1,session_version=session_version+1 WHERE email=$2 RETURNING id,email,role,session_version',[newHash,email]))[0]||null; }
 catch(e){ if(e?.code!=='42703')throw e; const r=(await sql.query('UPDATE wealth_users SET password_hash=$1 WHERE email=$2 RETURNING id,email,role',[newHash,email]))[0]; return r?{...r,session_version:1}:null; }
}
function tooMany(res,retryAfter){
 res.setHeader('Retry-After',String(retryAfter||WINDOW));
 return json(res,429,{error:'Too many attempts. Please wait and try again.'});
}

export default async function handler(req,res){
 try {
  const action = new URL(req.url,'https://local').searchParams.get('action');
  if(req.method==='GET'){
   const uid=await sessionUser(req);
   if(!uid)return json(res,200,{user:null});
   const rows=await sql.query('SELECT id,email,role,created_at FROM wealth_users WHERE id=$1',[uid]);
   return json(res,200,{user:rows[0]||null});
  }
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(action==='logout'){cookie(res,'');return json(res,200,{ok:true});}
  await schema();
  const ip=clientIp(req);
  const data=await body(req);
  const e=String(data.email||'').trim().toLowerCase();
  const p=String(data.password||'');
  if(!validEmail(e))return json(res,400,{error:'Enter a valid email address.'});
  if(p.length>PASSWORD_MAX)return json(res,400,{error:'Password is too long.'});

  if(action==='login'){
   const [ipCount,emailCount]=await Promise.all([rateCount('login:ip:'+ip),rateCount('login:email:'+e)]);
   if(ipCount>=IP_LIMIT||emailCount>=EMAIL_LIMIT)return tooMany(res,WINDOW);
   const user=await findUserByEmail(e);
   if(!user||!check(p,user.password_hash)){
    await Promise.all([rateLimit('login:ip:'+ip,IP_LIMIT,WINDOW),rateLimit('login:email:'+e,EMAIL_LIMIT,WINDOW)]);
    return json(res,401,{error:'Email or password is incorrect.'});
   }
   await rateReset('login:email:'+e);
   cookie(res,token(user.id,user.session_version));
   return json(res,200,{user:{id:user.id,email:user.email,role:user.role}});
  }

  // Register and reset share an IP limit so they cannot be used to brute-force the access key.
  const limited=await rateLimit('auth:ip:'+ip,IP_LIMIT,WINDOW);
  if(!limited.allowed)return tooMany(res,limited.retryAfter);

  if(action==='register'){
   if(!accessAllowed(data.secretKey))return json(res,403,{error:'Secret key is incorrect.'});
   const problem=passwordProblem(p);if(problem)return json(res,400,{error:problem});
   const rows=await sql.query('INSERT INTO wealth_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id,email,role',[e,hash(p)]);
   if(!rows.length)return json(res,409,{error:'An account with this email already exists.'});
   cookie(res,token(rows[0].id,1));
   return json(res,201,{user:rows[0]});
  }

  // Password reset is owner-only (TSD D2 default): a signed-in admin sets a new password for an account.
  // Anonymous resets are refused; a locked-out owner uses scripts/admin/reset-password.mjs.
  if(action==='reset'||action==='forgot'){
   const callerId=await sessionUser(req);
   const caller=callerId?(await sql.query('SELECT id,role FROM wealth_users WHERE id=$1',[callerId]))[0]:null;
   if(!caller||caller.role!=='admin')return json(res,403,{error:'Password reset is done by the account owner while signed in. Contact the owner to reset your password.'});
   const problem=passwordProblem(p);if(problem)return json(res,400,{error:problem});
   const updated=await setPassword(e,hash(p));
   if(!updated)return json(res,404,{error:'No account was found for that email.'});
   // Resetting your own password revokes your old sessions too; issue a fresh cookie for this one.
   if(updated.id===caller.id)cookie(res,token(updated.id,updated.session_version));
   return json(res,200,{ok:true,message:'Password reset. Existing sessions for that account were signed out.'});
  }
  return json(res,400,{error:'Unknown action'});
 } catch(e) {
  console.error('Wealth auth failure:', e?.message || 'unknown error');
  return json(res,500,{error:'Server configuration or database error.'});
 }
}
