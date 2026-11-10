import {sql,schema,json,body,sessionUser,cacheGet,cacheSet,cacheDel,invalidateUserCaches,scheduleCacheRefresh} from '../_lib.js';
import {pageTransactions,PAGE_DEFAULT} from '../_queries.js';

// Only the default first page is cached; later pages and custom sizes always read Neon.
const cacheKey=uid=>'wealth:ledger:v2:'+uid;
const KINDS=['income','expense','transfer','investment','liability'];

export default async function handler(req,res){
 try{const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});await schema();
 if(req.method==='GET'){
  const q=new URL(req.url,'https://local').searchParams;
  const cursor=q.get('cursor'),limit=Number(q.get('limit'))||PAGE_DEFAULT;
  const firstPage=!cursor&&limit===PAGE_DEFAULT;
  if(firstPage){
   const key=cacheKey(uid);const cached=await cacheGet(key);
   if(cached){try{const data=typeof cached==='string'?JSON.parse(cached):cached;if(data&&Array.isArray(data.transactions)){scheduleCacheRefresh(uid,'ledger',async()=>{await cacheSet(key,await pageTransactions(uid),20)},20);return json(res,200,data)}}catch(e){console.warn('[wealth-ledger:cache-invalid]',e?.message||e)}await cacheDel(key)}
   const data=await pageTransactions(uid);await cacheSet(key,data,20);return json(res,200,data);
  }
  return json(res,200,await pageTransactions(uid,{cursor,limit}));
 }
 if(req.method==='POST'){
  const b=await body(req);const kind=String(b.kind||'');const category=String(b.category||'').trim().slice(0,60);const description=String(b.description||'').slice(0,180);const account=String(b.account||'').slice(0,80);const amount=Number(b.amount);const date=String(b.date||'');
  const accountIdIn=b.accountId?String(b.accountId):'';const externalRef=b.externalRef?String(b.externalRef).trim().slice(0,120):'';
  if(!KINDS.includes(kind)||!category||!Number.isFinite(amount)||amount<=0||amount>1e12||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z')))return json(res,400,{error:'Invalid transaction details'});
  if(accountIdIn&&!/^[0-9a-f-]{36}$/i.test(accountIdIn))return json(res,400,{error:'Invalid account'});
  let accountId=null;
  if(accountIdIn){const r=await sql.query('SELECT id FROM wealth_accounts WHERE user_id=$1 AND id=$2',[uid,accountIdIn]);if(!r.length)return json(res,400,{error:'Invalid account'});accountId=r[0].id}
  else if(account){const r=await sql.query("SELECT id FROM wealth_accounts WHERE user_id=$1 AND (lower(account_name)=lower($2) OR lower(trim(account_name || ' ' || COALESCE(masked_identifier,'')))=lower($2) OR lower(account_key)=lower($2)) LIMIT 1",[uid,account]);accountId=r[0]?.id||null}
  let rows;
  try{
   rows=externalRef
    ?await sql.query("INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on,external_ref) VALUES($1,$2,$3,$4,$5,'',$6,$7,$8) RETURNING id,kind,category,description,amount,account_id,occurred_on",[uid,kind,category,description,amount,accountId,date,externalRef])
    :await sql.query("INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on) VALUES($1,$2,$3,$4,$5,'',$6,$7) RETURNING id,kind,category,description,amount,account_id,occurred_on",[uid,kind,category,description,amount,accountId,date]);
  }catch(e){
   if(e?.code==='23505')return json(res,409,{error:'This transaction reference is already recorded.'});
   if(e?.code==='42703')return json(res,400,{error:'Transaction references are not enabled yet.'});
   throw e;
  }
  await invalidateUserCaches(uid);return json(res,201,{transaction:rows[0]})
 }
 if(req.method==='DELETE'){
  const id=new URL(req.url,'https://local').searchParams.get('id');if(!id||!/^[0-9a-f-]{36}$/i.test(id))return json(res,400,{error:'Transaction id required'});
  const rows=await sql.query('DELETE FROM wealth_transactions WHERE id=$1 AND user_id=$2 RETURNING id',[id,uid]);
  if(rows.length)await invalidateUserCaches(uid);return json(res,200,{deleted:rows.length===1})
 }
 return json(res,405,{error:'Method not allowed'});
 }catch(e){console.error('[wealth-ledger]',e?.message||e);return json(res,500,{error:'Unable to access ledger.'})}
}
