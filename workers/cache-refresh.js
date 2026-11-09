import { Kafka } from 'kafkajs';
import { neon } from '@neondatabase/serverless';
import { createClient } from 'redis';

const dbUrl=process.env.POSTGRES_URL||process.env.WEALTH_DATABASE_URL||process.env.DATABASE_URL;
const redisUrl=process.env.REDIS_URL;
const brokers=String(process.env.KAFKA_BROKERS||'').split(',').map(x=>x.trim()).filter(Boolean);
if(!dbUrl||!redisUrl||!brokers.length)throw new Error('Set WEALTH_DATABASE_URL, REDIS_URL, and KAFKA_BROKERS before starting the worker.');
const sql=neon(dbUrl);
const redis=createClient({url:redisUrl});
redis.on('error',e=>console.error('[wealth-worker:redis]',e?.message||e));
await redis.connect();
const kafka=new Kafka({
 clientId:process.env.KAFKA_CLIENT_ID||'wealth-cache-worker',
 brokers,
 ssl:String(process.env.KAFKA_SSL||'true').toLowerCase()!=='false',
 ...(process.env.KAFKA_USERNAME&&process.env.KAFKA_PASSWORD?{
  sasl:{mechanism:process.env.KAFKA_SASL_MECHANISM||'plain',username:process.env.KAFKA_USERNAME,password:process.env.KAFKA_PASSWORD}
 }: {})
});
const consumer=kafka.consumer({groupId:process.env.KAFKA_GROUP_ID||'wealth-cache-refresh-v1'});
const topic=process.env.KAFKA_CACHE_REFRESH_TOPIC||'wealth.cache.refresh.v1';
const key=(resource,uid)=>resource==='dashboard'?'wealth:dashboard:v2:'+uid:resource==='ledger'?'wealth:ledger:v1:'+uid:'wealth:snapshots:v2:'+uid;

async function dashboard(uid){
 const [users,transactions,templates,accounts,positions]=await Promise.all([
  sql("SELECT role FROM wealth_users WHERE id=$1",[uid]),
  sql("SELECT t.id,t.kind,t.category,t.description,t.amount,t.account_id,COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,t.occurred_on FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 500",[uid]),
  sql("SELECT config,version,updated_at FROM wealth_templates WHERE user_id=$1 AND template_key='wealth_classification' LIMIT 1",[uid]),
  sql("SELECT id,account_key,bank_name,account_name,account_type,masked_identifier,currency,current_balance,balance_as_of,balance_status FROM wealth_accounts WHERE user_id=$1 ORDER BY bank_name,account_name",[uid]),
  sql("SELECT id,category,institution_name,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of,source_key,metadata FROM wealth_positions WHERE user_id=$1 ORDER BY category,platform_name,record_type,name",[uid])
 ]);
 if(!users.length)return null;
 const role=users[0].role;
 const snapshots=role==='admin'?await sql('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid]):[];
 return {role,transactions,snapshots,template:templates[0]?.config||null,accounts,positions};
}
async function refresh(uid,resource){
 let value;
 if(resource==='dashboard')value=await dashboard(uid);
 else if(resource==='ledger'){
  value={transactions:await sql("SELECT t.id,t.kind,t.category,t.description,t.amount,t.account_id,COALESCE(NULLIF(trim(a.account_name || ' ' || COALESCE(a.masked_identifier,'')),''),NULLIF(t.account,''),'Unassigned') AS account,t.occurred_on FROM wealth_transactions t LEFT JOIN wealth_accounts a ON a.user_id=t.user_id AND a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 500",[uid])};
 }else if(resource==='snapshots'){
  const users=await sql('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  if(!users.length||users[0].role!=='admin')return;
  value={snapshots:await sql('SELECT id,source_key,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC,created_at DESC',[uid])};
 }else return;
 if(value)await redis.set(key(resource,uid),JSON.stringify(value),{EX:resource==='dashboard'?120:resource==='ledger'?20:60});
}
await consumer.connect();
await consumer.subscribe({topic,fromBeginning:false});
console.log('[wealth-worker] consuming',topic);
await consumer.run({eachMessage:async({message})=>{
 let event;
 try{event=JSON.parse(message.value?.toString()||'{}')}catch{return}
 const uid=String(event.uid||''),resource=String(event.resource||'');
 if(!uid||uid.length>128||!['dashboard','ledger','snapshots'].includes(resource))return;
 try{
  await refresh(uid,resource);
  await redis.del('wealth:refresh-lock:v1:'+uid+':'+resource);
 }catch(error){
  console.error('[wealth-worker:refresh]',resource,error?.message||error);
  // Throw so Kafka does not commit this message; the consumer will retry.
  throw error;
 }
}});
const shutdown=async()=>{try{await consumer.disconnect();await redis.quit()}finally{process.exit(0)}};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
