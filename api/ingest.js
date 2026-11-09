import { neon } from '@neondatabase/serverless';
import { createHash, timingSafeEqual } from 'node:crypto';
import { json, body } from './_lib.js';

const db=process.env.WEALTH_INGESTION_DATABASE_URL?neon(process.env.WEALTH_INGESTION_DATABASE_URL):null;
const hash=s=>createHash('sha256').update(s).digest('hex');
function parse(text,source){
 const s=String(text||'').slice(0,12000);
 if(/\b(OTP|one.time password|verification code|do not share)\b/i.test(s))return {ignore:true};
 const amountMatch=s.match(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i)||s.match(/(?:debited|credited|spent|received|withdrawn|deposited)[^\d]{0,30}([\d,]+(?:\.\d{1,2})?)/i);
 if(!amountMatch)return {ignore:true};
 const amount=Number(amountMatch[1].replace(/,/g,''));
 if(!Number.isFinite(amount)||amount<=0)return {ignore:true};
 const debit=/\b(debited|spent|purchase|withdrawn|paid|sent)\b/i.test(s);
 const credit=/\b(credited|received|deposited|refund)\b/i.test(s);
 if(debit===credit)return {ignore:true};
 const banks=['Bank of India','BOI','HDFC Bank','ICICI Bank','State Bank of India','SBI','Axis Bank','Kotak Mahindra','IDFC FIRST','Federal Bank','Canara Bank','Union Bank','Slice','Roarbank'];
 const bank=banks.find(x=>new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(s))||'Unknown bank';
 const ref=(s.match(/(?:UPI Ref(?:erence)?|UTR|RRN|Txn(?:\s|\.)?ID|Ref(?:erence)?(?:\s|\.)?No)\s*[:#-]?\s*([A-Z0-9-]{6,30})/i)||[])[1]||null;
 const date=(s.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/)||[])[1]||null;
 return {ignore:false,bank,direction:debit?'debit':'credit',amount,currency:'INR',reference:ref,description:s.replace(/\s+/g,' ').slice(0,240),date};
}
export default async function handler(req,res){
 try{
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(process.env.WEALTH_INGESTION_ENABLED!=='true'||!db)return json(res,503,{error:'Ingestion is disabled.'});
  const auth=String(req.headers.authorization||''); const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!token||token.length>200)return json(res,401,{error:'Device authentication required'});
  const tokenHash=hash(token);
  const rows=await db.query('SELECT user_id FROM wealth_ingestion_tokens WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1',[tokenHash]);
  if(!rows.length)return json(res,401,{error:'Invalid or revoked device token'});
  const uid=rows[0].user_id; const b=await body(req);
  if(!['sms','email'].includes(b.source)||!b.externalId||typeof b.text!=='string')return json(res,400,{error:'source, externalId and text are required'});
  const parsed=parse(b.text,b.source); if(parsed.ignore)return json(res,200,{status:'ignored'});
  const rawHash=hash(b.text.trim().toLowerCase());
  const id=String(b.externalId).slice(0,200);
  const inserted=await db.query("INSERT INTO wealth_ingestion_events(user_id,source,external_id,bank_name,direction,amount,currency,occurred_at,reference,description,raw_hash,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'staged',$12::jsonb) ON CONFLICT DO NOTHING RETURNING id,status",[uid,b.source,id,parsed.bank,parsed.direction,parsed.amount,parsed.currency,b.occurredAt||null,parsed.reference,parsed.description,rawHash,JSON.stringify({parsed,provider:b.provider||null})]);
  return json(res,200,{status:inserted.length?'staged':'duplicate',eventId:inserted[0]?.id||null});
 }catch(e){console.error('[wealth-ingest]',e?.message||e);return json(res,500,{error:'Unable to ingest event.'})}
}
