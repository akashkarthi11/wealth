import {sql,json,userFrom,body,invalidateUserCaches} from './_lib.js';
export default async function handler(req,res){
 try{
  const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
  if(req.method==='GET'){
   const rows=await sql.query("SELECT b.id,b.title,b.amount,b.due_date,b.category,b.payee,b.reference_masked,b.recurrence,b.status,a.bank_name,a.account_name,a.masked_identifier FROM wealth_planned_bills b LEFT JOIN wealth_accounts a ON a.id=b.account_id AND a.user_id=b.user_id WHERE b.user_id=$1 AND b.status='planned' ORDER BY b.due_date ASC",[uid]);
   return json(res,200,{bills:rows});
  }
  if(req.method==='PATCH'){
   const b=await body(req);const id=String(b.id||'');const status=String(b.status||'');
   if(!id||!['paid','cancelled','planned'].includes(status))return json(res,400,{error:'Invalid bill update'});
   const rows=await sql.query("UPDATE wealth_planned_bills SET status=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,status",[id,uid,status]);
   if(!rows.length)return json(res,404,{error:'Planned bill not found'});
   return json(res,200,{bill:rows[0]});
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){console.error('[wealth-planned-bills]',e?.message||e);return json(res,500,{error:'Unable to load planned bills.'})}
}