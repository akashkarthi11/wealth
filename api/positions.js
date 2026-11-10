import {sql,schema,json,body,sessionUser,invalidateUserCaches,dataModel} from './_lib.js';
import {createFixedDepositAccount} from './_queries.js';

// Add a fixed deposit.
//   v1: a FIXED_DEPOSIT row in wealth_positions (legacy model).
//   v2: a fixed_deposit account plus its first balance, in one statement (TSD TR-5.6).
const slug=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

export default async function handler(req,res){
 try{
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  await schema();
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  const b=await body(req);
  const name=String(b.name||'').trim().slice(0,120);
  const institution=String(b.institution_name||'').trim().slice(0,120)||null;
  const invested=Number(b.invested_value),current=Number(b.current_value);
  const rate=b.interest_rate===''||b.interest_rate==null?null:Number(b.interest_rate);
  const maturity=String(b.maturity_date||'').trim();
  if(!name||!Number.isFinite(invested)||invested<=0||invested>1e12||!Number.isFinite(current)||current<=0||current>1e12||
    (rate!==null&&(!Number.isFinite(rate)||rate<0||rate>100))||
    (maturity&&(!/^\d{4}-\d{2}-\d{2}$/.test(maturity)||!Number.isFinite(Date.parse(maturity+'T00:00:00Z'))))){
   return json(res,400,{error:'Enter a valid FD name, invested amount and current value. Interest rate and maturity date are optional.'});
  }

  if(dataModel()==='v2'){
   const bank=institution||'Angel One';
   const note=['Invested ₹'+invested.toFixed(2),rate!==null?rate+'% p.a.':null,maturity?'matures '+maturity:null].filter(Boolean).join(' · ');
   try{
    const r=await createFixedDepositAccount(uid,{key:slug(bank)+'-fixed_deposit-'+slug(name),institution:bank,name,balance:current,note});
    await invalidateUserCaches(uid);
    return json(res,201,{account:{id:r.id,category:'INVESTMENT',subtype:'fixed_deposit',institution:r.institution,name:r.name,currency:'INR',
     balance:{amount:Number(r.balance),currency:'INR'},balanceAsOf:r.as_of,balanceStatus:r.status,balanceNote:r.note,holdings:[]}});
   }catch(e){
    if(e?.code==='23505')return json(res,409,{error:'An FD with this name already exists at this institution.'});
    throw e;
   }
  }

  const metadata={};
  if(rate!==null)metadata.interest_rate=rate;
  if(maturity)metadata.maturity_date=maturity;
  const rows=await sql.query(
   "INSERT INTO wealth_positions(user_id,category,institution_name,platform_name,record_type,name,currency,current_value,invested_value,balance_as_of,source_key,metadata) VALUES($1,'INVESTMENT',$2,'Angel One','FIXED_DEPOSIT',$3,'INR',$4,$5,now(),'manual-angel-one-fd',$6::jsonb) RETURNING id,category,institution_name,platform_name,record_type,name,currency,current_value,invested_value,balance_as_of,source_key,metadata",
   [uid,institution,name,current,invested,JSON.stringify(metadata)]
  );
  await invalidateUserCaches(uid);
  return json(res,201,{position:rows[0]});
 }catch(e){console.error('[wealth-positions]',e?.message||e);return json(res,500,{error:'Unable to save fixed deposit.'})}
}
