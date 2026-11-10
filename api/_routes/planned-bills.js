import {sql,json,sessionUser,body,invalidateUserCaches} from '../_lib.js';
import {setBillStatus} from '../_queries.js';
export default async function handler(req,res){
 try{
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  if(req.method==='GET'){
   const [rows,subscriptions,commitments]=await Promise.all([
    sql.query("SELECT b.id,b.obligation_id,b.title,b.amount,b.due_date,b.category,b.payee,b.reference_masked,b.recurrence,b.status,a.bank_name,a.account_name,a.masked_identifier,a.current_balance,a.balance_as_of,a.balance_status FROM wealth_planned_bills b LEFT JOIN wealth_accounts a ON a.id=b.account_id AND a.user_id=b.user_id WHERE b.user_id=$1 AND b.status='planned' ORDER BY b.due_date ASC",[uid]),
    sql.query("SELECT s.id,s.obligation_id,s.provider_name,s.amount,s.amount_type,s.frequency,s.status,s.next_due_date,s.merchant_id,a.bank_name,a.account_name,a.masked_identifier FROM wealth_subscriptions s LEFT JOIN wealth_accounts a ON a.id=s.source_account_id AND a.user_id=s.user_id WHERE s.user_id=$1 AND s.status='active' ORDER BY s.provider_name",[uid]),
    sql.query("SELECT o.id,o.title,o.obligation_type,o.expected_amount,o.amount_type,o.frequency,o.next_due_date,o.source_type,o.status,a.bank_name,a.account_name,a.masked_identifier FROM wealth_recurring_obligations o LEFT JOIN wealth_accounts a ON a.id=o.account_id AND a.user_id=o.user_id WHERE o.user_id=$1 AND o.status='active' AND o.source_type IN ('planned_bill','manual') ORDER BY o.next_due_date NULLS LAST,o.title",[uid]).catch(e=>{console.warn('[wealth-planned-bills:commitments]',e?.message||e);return []})
   ]);
   return json(res,200,{bills:rows,subscriptions,commitments});
  }
  if(req.method==='PATCH'){
   const b=await body(req);const id=String(b.id||'');const status=String(b.status||'');
   if(!/^[0-9a-f-]{36}$/i.test(id)||!['paid','cancelled','planned'].includes(status))return json(res,400,{error:'Invalid bill update'});
   const bill=await setBillStatus(uid,id,status);
   if(!bill)return json(res,404,{error:'Planned bill not found'});
   await invalidateUserCaches(uid);
   return json(res,200,{bill});
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){console.error('[wealth-planned-bills]',e?.message||e);return json(res,500,{error:'Unable to load planned bills.'})}
}