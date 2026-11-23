import {sql,schema,json,sessionUser,body} from '../_lib.js';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {startJob,finishJob} from '../_jobs.js';
import {SCHEDULE_TIMEZONE,DEFAULT_SCHEDULE_TIME,nextScheduledAt,getLocalDateTime} from '../_lib/stock-advisor-schedule-time.js';
import { listFincruxKeyMetadata } from '../_lib/provider-api-keys.js';

// The agents' shared WEALTH_INGEST_SECRET (Plan 3) or the older advisor-only secret.
function validIngestSecret(req){
 const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 return [process.env.WEALTH_INGEST_SECRET,process.env.WEALTH_ADVISOR_INGEST_SECRET].some(v=>{
  const expected=String(v||'').trim();
  if(expected.length<32||supplied.length!==expected.length)return false;
  try{return timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))}catch{return false}
 });
}

async function latestSavedReport(uid){
 const reports=await sql.query(
  'SELECT id,run_id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC LIMIT 1',[uid]
 );
 if(reports.length)return reports[0];
 // Backward-compatible fallback for older hourly monitor snapshots.
 const snapshots=await sql.query(
  "SELECT id,snapshot_date AS run_at,payload FROM wealth_snapshots WHERE user_id=$1 AND (source_key ILIKE 'stock-advisor%' OR source_name ILIKE '%stock advisor%') ORDER BY snapshot_date DESC,created_at DESC LIMIT 1",
  [uid]
 );
 if(!snapshots.length)return null;
 let payload=snapshots[0].payload;
 if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload={summary:payload}}}
 payload=payload&&typeof payload==='object'?payload:{};
 return {id:snapshots[0].id,run_id:null,run_at:snapshots[0].run_at,
  report_text:payload.report_text||payload.reportText||payload.summary||payload.text||'',
  report_json:payload.report_json||payload.reportJson||payload};
}

function cleanBullBearCases(input){
 if(input==null)return [];
 if(!Array.isArray(input))throw Object.assign(new Error('bull_bear_cases must be an array.'),{status:400});
 if(input.length>1000)throw Object.assign(new Error('A run can contain at most 1000 Bull/Bear cases.'),{status:400});
 const json=(v,fallback,type)=>{const x=v==null?fallback:v;if(typeof x!==type)throw Object.assign(new Error('Invalid Bull/Bear evidence structure.'),{status:400});return x};
 return input.map(c=>{
  if(!c||typeof c!=='object'||Array.isArray(c))throw Object.assign(new Error('Each Bull/Bear case must be an object.'),{status:400});
  const side=String(c.side||'').toLowerCase(),ticker=String(c.ticker||c.symbol||'').trim().toUpperCase(),stockName=String(c.stock_name||c.stockName||c.company||ticker).trim(),thesis=String(c.thesis||c.argument||'').trim();
  if(!['bull','bear'].includes(side)||!ticker||ticker.length>30||!stockName||stockName.length>160||!thesis||thesis.length>30000)throw Object.assign(new Error('Each Bull/Bear case needs side, ticker, stock name and thesis.'),{status:400});
  const confidence=c.confidence==null?null:Number(c.confidence),target=c.target_price==null&&c.targetPrice==null?null:Number(c.target_price??c.targetPrice);
  if(confidence!=null&&(!Number.isFinite(confidence)||confidence<0||confidence>100))throw Object.assign(new Error('Bull/Bear confidence must be 0–100.'),{status:400});
  if(target!=null&&(!Number.isFinite(target)||target<0))throw Object.assign(new Error('Bull/Bear target price must be zero or greater.'),{status:400});
  return {ticker,stock_name:stockName,exchange:String(c.exchange||'NSE').slice(0,20),side,agent_key:String(c.agent_key||c.agent_id||'').slice(0,100),agent_name:String(c.agent_name||c.agent||'').slice(0,100),thesis,key_points:json(c.key_points??c.keyPoints,[],'object'),fundamental_evidence:json(c.fundamental_evidence??c.fundamentalEvidence,{},'object'),technical_evidence:json(c.technical_evidence??c.technicalEvidence,{},'object'),valuation:json(c.valuation,{},'object'),catalysts:json(c.catalysts,[],'object'),risks:json(c.risks,[],'object'),sources:json(c.sources,[],'object'),confidence,target_price:target,time_horizon:c.time_horizon??c.timeHorizon??null,verdict:c.verdict??null};
 }).map(c=>{
  for(const k of ['key_points','catalysts','risks','sources'])if(!Array.isArray(c[k]))throw Object.assign(new Error(k+' must be an array.'),{status:400});
  for(const k of ['fundamental_evidence','technical_evidence','valuation'])if(!c[k]||Array.isArray(c[k])||typeof c[k]!=='object')throw Object.assign(new Error(k+' must be an object.'),{status:400});
  return c;
 });
}

function cleanMessages(input){
 if(input==null)return [];
 if(!Array.isArray(input))throw Object.assign(new Error('messages must be an array.'),{status:400});
 if(input.length>5000)throw Object.assign(new Error('A run can contain at most 5000 messages.'),{status:400});
 return input.map((m,i)=>{
  if(!m||typeof m!=='object'||Array.isArray(m))throw Object.assign(new Error('Each message must be an object.'),{status:400});
  const content=String(m.content??m.text??'').trim();
  const speaker=String(m.speaker??m.agent_name??m.agent??m.role??'').trim().slice(0,100);
  if(!content||content.length>30000||!speaker)throw Object.assign(new Error('Each message needs a speaker and 1–30000 characters of content.'),{status:400});
  const createdAt=m.created_at??m.timestamp??null;
  if(createdAt&&!Number.isFinite(Date.parse(createdAt)))throw Object.assign(new Error('Message timestamps must be valid dates.'),{status:400});
  const metadata=m.metadata&&typeof m.metadata==='object'&&!Array.isArray(m.metadata)?m.metadata:{};
  const sequenceNo=Number.isInteger(m.sequence_no)?m.sequence_no:i;
  if(sequenceNo<0)throw Object.assign(new Error('Message sequence numbers must be zero or greater.'),{status:400});
  const sentences=content.replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).slice(0,3).join(' ').slice(0,900);
  const evidenceRefs=Array.isArray(m.evidence_refs)?m.evidence_refs:[];
  return {sequence_no:sequenceNo,
   round_no:Number.isInteger(m.round_no)&&m.round_no>0?m.round_no:1,
   speaker,agent_key:String(m.agent_key??m.agent_id??'').slice(0,100),
   message_type:String(m.message_type??m.type??'message').slice(0,40),
   content,summary:String(m.summary||sentences),ticker:String(m.ticker||'').toUpperCase(),asset_type:String(m.asset_type||''),evidence_refs:evidenceRefs,metadata,created_at:createdAt};
 });
}




async function loadResearchHealth(uid,holdings){
 const tickers=[...new Set((holdings||[]).filter(h=>h.currency==='INR'&&['EQUITY','ETF'].includes(String(h.record_type||'').toUpperCase())).map(h=>String(h.ticker||'').trim().toUpperCase()).filter(Boolean))];
 const providers=[
  {key:'tejhq',name:'TejHQ',status:'available',detail:'NSE end-of-day prices · no API key'},
  {key:'mfapi',name:'MFAPI.in',status:'available',detail:'Indian mutual-fund NAV · no API key'},
  {key:'nse',name:'NSE disclosures',status:'available',detail:'Official RSS listings · filing content still needs verification'},
  {key:'fincrux',name:'Fincrux',status:fincruxKeys.total_enabled?'configured':'needs_key',detail:fincruxKeys.total_enabled+' active key(s) · automatic fallback · unverified until official cross-check'},
  {key:'nemotron',name:'Nemotron Free',status:String(process.env.AI_GATEWAY_API_KEY||'').trim()?'configured':'needs_key',detail:'Primary free AI model through Vercel AI Gateway'},
  {key:'groq',name:'Groq Free',status:String(process.env.GROQ_API_KEY||'').trim()?(String(process.env.GROQ_ZERO_DATA_RETENTION_CONFIRMED||'').toLowerCase()==='true'?'configured':'blocked'):'needs_key',detail:'Fallback requires API key and confirmed Zero Data Retention'}
 ];
 if(!tickers.length)return {status:'ok',eligible_equities:0,coverage:{},providers,fincrux_keys:fincruxKeys,last_collection:null,evidence_summary:[]};
 try{
  const [coverageRows,evidenceRows,collectionRows]=await Promise.all([
   sql.query(`SELECT
     count(DISTINCT upper(ticker)) FILTER (WHERE source_type='market_price' AND verification_status='verified' AND retrieved_at>now()-interval '36 hours')::int AS verified_prices,
     count(DISTINCT upper(ticker)) FILTER (WHERE source_type='technical_indicator' AND verification_status='verified' AND retrieved_at>now()-interval '36 hours')::int AS verified_technicals,
     count(DISTINCT upper(ticker)) FILTER (WHERE source_type='financial_statement' AND verification_status='verified' AND retrieved_at>now()-interval '400 days')::int AS verified_financials,
     count(DISTINCT upper(ticker)) FILTER (WHERE source_type='financial_statement' AND verification_status='unverified' AND retrieved_at>now()-interval '400 days')::int AS unverified_financials
    FROM wealth_stock_advisor_research_sources
    WHERE run_id IS NULL AND upper(ticker)=ANY($1::text[])`,[tickers]),
   sql.query(`SELECT publisher,source_type,verification_status,count(*)::int AS records,max(retrieved_at) AS latest_retrieved
    FROM wealth_stock_advisor_research_sources
    WHERE run_id IS NULL AND upper(ticker)=ANY($1::text[])
    GROUP BY publisher,source_type,verification_status
    ORDER BY publisher,source_type,verification_status`,[tickers]),
   sql.query('SELECT id,started_at,finished_at,status,summary,error FROM wealth_stock_advisor_data_collection_runs ORDER BY started_at DESC LIMIT 1')
  ]);
  const coverage=coverageRows[0]||{};
  return {
   status:'ok',eligible_equities:tickers.length,
   coverage:{
    verified_prices:Number(coverage.verified_prices||0),
    verified_technicals:Number(coverage.verified_technicals||0),
    verified_financials:Number(coverage.verified_financials||0),
    unverified_financials:Number(coverage.unverified_financials||0)
   },
   providers,
   last_collection:collectionRows[0]||null,
   evidence_summary:evidenceRows
  };
 }catch(error){
  return {status:'unavailable',eligible_equities:tickers.length,coverage:{},providers,fincrux_keys:fincruxKeys,last_collection:null,evidence_summary:[],error:String(error?.message||error).slice(0,180)};
 }
}

async function getAutoResearchSettings(uid){
 const rows=await sql.query('SELECT enabled,mode,selected_tickers,schedule_timezone,schedule_time,schedule_frequency,last_run_at,last_success_at,last_scheduled_date,next_run_at,last_status,last_error FROM wealth_stock_advisor_settings WHERE user_id=$1',[uid]);
 const settings=rows[0]||{enabled:false,mode:'all',selected_tickers:[],schedule_timezone:SCHEDULE_TIMEZONE,schedule_time:DEFAULT_SCHEDULE_TIME,schedule_frequency:'daily',last_run_at:null,last_success_at:null,last_scheduled_date:null,next_run_at:null,last_status:'not_configured',last_error:null};
 if(settings.enabled)settings.next_run_at=nextScheduledAt(new Date(),settings.schedule_time||DEFAULT_SCHEDULE_TIME,settings.schedule_frequency||'daily',settings.schedule_timezone||SCHEDULE_TIMEZONE).toISOString();
 else settings.next_run_at=null;
 settings.scheduler_registered=String(process.env.VERCEL_ENV||'').toLowerCase()==='production';
 settings.scheduler_status=settings.enabled?(settings.scheduler_registered?'active':'preview_only'):'disabled';
 settings.execution_window='09:48–10:47 IST';
 return settings;
}
async function saveAutoResearchSettings(req,res){
 const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
 const input=await body(req),enabled=input.enabled===true,mode=String(input.mode||'all');
 if(!['all','manual'].includes(mode))return json(res,400,{error:'Choose all investments or manual selection.'});
 const selected=Array.isArray(input.selected_tickers)?[...new Set(input.selected_tickers.map(x=>String(x||'').trim().toUpperCase()).filter(x=>/^[A-Z0-9&.-]{1,20}$/.test(x)))]:[];
 if(selected.length>100)return json(res,400,{error:'Select no more than 100 stocks.'});
 if(mode==='manual'&&!selected.length)return json(res,400,{error:'Select at least one stock for manual mode.'});
 if(selected.length){const valid=await sql.query("SELECT DISTINCT upper(ticker) AS ticker FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF') AND currency='INR' AND upper(ticker)=ANY($2::text[])",[uid,selected]);if(valid.length!==selected.length)return json(res,400,{error:'Manual selection may include only saved Indian equity or ETF holdings.'})}
 const now=new Date(),local=getLocalDateTime(now,SCHEDULE_TIMEZONE),[currentSchedule]=await sql.query('SELECT schedule_time FROM wealth_stock_advisor_settings WHERE user_id=$1',[uid]);
 const scheduleTime=currentSchedule?.schedule_time||DEFAULT_SCHEDULE_TIME,prior=new Date(Date.UTC(local.year,local.month-1,local.day-1)).toISOString().slice(0,10),lastScheduledDate=enabled&&local.time<scheduleTime?prior:local.date;
 await sql.query("INSERT INTO wealth_stock_advisor_settings (user_id,enabled,mode,selected_tickers,last_scheduled_date,last_status,last_error,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,NULL,now()) ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,selected_tickers=EXCLUDED.selected_tickers,last_scheduled_date=EXCLUDED.last_scheduled_date,last_status=EXCLUDED.last_status,last_error=NULL,updated_at=now()",[uid,enabled,mode,JSON.stringify(selected),lastScheduledDate,enabled?'scheduled':'disabled']);
 const settings=await getAutoResearchSettings(uid);
 return json(res,200,{saved:true,settings,message:enabled?'Settings saved. Use Research Schedule to configure the daily IST time and frequency; Preview deployments do not receive automatic Vercel Cron events.':'Auto Research is off for this account.'});
}

// Free-model pilot: separate Gateway calls; only public company/ticker identifiers leave this application.
// Hard allowlist: this route must never invoke a billable model, even if a future caller passes one.
const FREE_AI_MODEL='nvidia/nemotron-3.5-lightning-free';
async function gatewayChat(model,messages){
 if(model!==FREE_AI_MODEL)throw Object.assign(new Error('Blocked AI model: only the approved free model is allowed.'),{status:403});
 const key=String(process.env.AI_GATEWAY_API_KEY||'').trim();
 if(!key)throw Object.assign(new Error('AI_GATEWAY_API_KEY is not configured for this deployment.'),{status:503});
 const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.25,max_tokens:4096,reasoning:{effort:'none'},response_format:{type:'json_object'}})});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(new Error('AI Gateway request failed ('+response.status+'): '+String(payload?.error?.message||payload?.message||'provider unavailable').slice(0,240)),{status:502});
 const choice=payload?.choices?.[0],content=choice?.message?.content;
 if(typeof content!=='string'||!content.trim()){
  const finishReason=String(choice?.finish_reason||'unknown');
  const completionTokens=Number(payload?.usage?.completion_tokens||0);
  throw Object.assign(new Error('AI Gateway returned no final content (finish_reason='+finishReason+', completion_tokens='+completionTokens+').'),{status:502});
 }
 return content.trim();
}
function parseAgentJson(raw){
 const text=String(raw||'').trim(),start=text.indexOf('{'),end=text.lastIndexOf('}');
 const cleaned=start>=0&&end>start?text.slice(start,end+1):text;
 try{const v=JSON.parse(cleaned);return v&&typeof v==='object'&&!Array.isArray(v)?v:{thesis:cleaned,key_points:[],risks:[],sources:[]}}
 catch{return {thesis:cleaned,key_points:[],risks:[],sources:[]}}
}
function agentArray(v){return Array.isArray(v)?v:[]}
function agentObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}
async function runFreeModelPilot(req,res){
 const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
 const input=await body(req),ticker=String(input.ticker||'').trim().toUpperCase();
 if(!/^[A-Z0-9&.-]{1,20}$/.test(ticker))return json(res,400,{error:'Choose a valid Indian equity ticker from your holdings.'});
 const holdings=await sql.query("SELECT name,ticker FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type='EQUITY' AND currency='INR' AND upper(ticker)=upper($2) LIMIT 1",[uid,ticker]);
 if(!holdings.length)return json(res,404,{error:'That ticker is not in your saved Indian equity holdings.'});
 const company=String(holdings[0].name||ticker),runKey='free-pilot-'+randomUUID();
 const inserted=await sql.query("INSERT INTO wealth_stock_advisor_runs (user_id,run_key,run_at,status,agent_count) VALUES ($1,$2,now(),'running',3) RETURNING id,run_key,run_at,status,agent_count",[uid,runKey]),run=inserted[0];
 const boundary='You have only a public company name and ticker. No live market feed, verified current price, latest financial statements, current chart indicators or browsing are available. Never invent figures, dates, citations, prices, ratios or recent events. Mark unverified knowledge as background. Identify the exact primary-source data required before investment action.';
 const schemaText='Return JSON only: thesis (string), key_points (string array), fundamental_evidence (object), technical_evidence (object, state no live chart data), valuation (object, state no verified current valuation), catalysts (array), risks (array), sources (array, empty unless supplied), confidence (number 0-100), preliminary_action (BUY/HOLD/SELL/RESEARCH).';
 const base='Company: '+company+'. NSE ticker: '+ticker+'. India equities. '+boundary+' '+schemaText;
 try{
  const [bullRaw,bearRaw]=await Promise.all([
   gatewayChat(FREE_AI_MODEL,[{role:'system',content:'You are the independent BULL analyst. Build the strongest honest upside thesis and challenge your assumptions. Do not fabricate evidence.'},{role:'user',content:base+' Focus on business quality, growth drivers, competitive advantages, balance sheet questions and evidence needed to validate upside.'}]),
   gatewayChat(FREE_AI_MODEL,[{role:'system',content:'You are the independent BEAR analyst. You have not seen the Bull draft. Build the strongest honest downside thesis and search for disconfirming evidence. Do not fabricate evidence.'},{role:'user',content:base+' Focus on valuation risk, execution, governance, cyclicality, capital allocation, downside scenarios and evidence that could invalidate the thesis.'}])
  ]);
  const bull=parseAgentJson(bullRaw),bear=parseAgentJson(bearRaw);
  const cioRaw=await gatewayChat(FREE_AI_MODEL,[{role:'system',content:'You are CIO. Independently adjudicate both cases, identify disagreements, reject unsupported claims. You have no live data. Without verified current valuation, financials and technicals, decision must be HOLD / DATA REQUIRED, not a trade instruction. Return JSON only.'},{role:'user',content:base+' BULL CASE:\n'+JSON.stringify(bull)+'\nBEAR CASE:\n'+JSON.stringify(bear)+'\nReturn JSON: summary, decision (BUY/HOLD/SELL), reasons (array), unresolved_questions (array), data_required (array).'}]);
  const cio=parseAgentJson(cioRaw),messages=[
   {sequence_no:0,round_no:1,speaker:'Bull Analyst · Nemotron Free',agent_key:'bull-nemotron-free',message_type:'analysis',content:JSON.stringify(bull,null,2),metadata:{model:FREE_AI_MODEL,independent:true}},
   {sequence_no:1,round_no:1,speaker:'Bear Analyst · Nemotron Free',agent_key:'bear-nemotron-free',message_type:'analysis',content:JSON.stringify(bear,null,2),metadata:{model:FREE_AI_MODEL,independent:true}},
   {sequence_no:2,round_no:1,speaker:'CIO · Nemotron Free',agent_key:'cio-nemotron-free',message_type:'decision',content:JSON.stringify(cio,null,2),metadata:{model:FREE_AI_MODEL,adjudicates:['bull-nemotron-free','bear-nemotron-free']}}
  ];
  const cases=[{side:'bull',agent_key:'bull-nemotron-free',agent_name:'Bull Analyst · Nemotron Free',data:bull},{side:'bear',agent_key:'bear-nemotron-free',agent_name:'Bear Analyst · Nemotron Free',data:bear}];
  for(const c of cases){const a=c.data;await sql.query('INSERT INTO wealth_stock_advisor_bull_bear_cases (run_id,ticker,stock_name,exchange,side,agent_key,agent_name,thesis,key_points,fundamental_evidence,technical_evidence,valuation,catalysts,risks,sources,confidence,target_price,time_horizon,verdict) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,NULL,$17,$18)',[run.id,ticker,company,'NSE',c.side,c.agent_key,c.agent_name,String(a.thesis||'No thesis supplied.'),JSON.stringify(agentArray(a.key_points)),JSON.stringify(agentObject(a.fundamental_evidence)),JSON.stringify(agentObject(a.technical_evidence)),JSON.stringify(agentObject(a.valuation)),JSON.stringify(agentArray(a.catalysts)),JSON.stringify(agentArray(a.risks)),JSON.stringify(agentArray(a.sources)),a.confidence==null||!Number.isFinite(Number(a.confidence))?null:Math.max(0,Math.min(100,Number(a.confidence))),'Long term',String(a.preliminary_action||'RESEARCH')]);}
  for(const m of messages)await sql.query('INSERT INTO wealth_stock_advisor_messages (run_id,sequence_no,round_no,speaker,agent_key,message_type,content,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())',[run.id,m.sequence_no,m.round_no,m.speaker,m.agent_key,m.message_type,m.content,JSON.stringify(m.metadata)]);
  const decision=String(cio.decision||'HOLD').toUpperCase(),action=['BUY','HOLD','SELL'].includes(decision)?decision:'HOLD',summary=String(cio.summary||'Preliminary pilot. Current financial and market data are not verified; no trade instruction is issued.');
  const reportJson={summary,recommendations:[{ticker,symbol:ticker,company,action,reason:summary,risk:agentArray(cio.unresolved_questions).join('; ')}],free_model_pilot:true,models:[FREE_AI_MODEL,FREE_AI_MODEL],data_limitations:[boundary],cio};
  const reportText='FREE MODEL PILOT — '+company+' ('+ticker+')\n\n'+summary+'\n\nDecision: '+action+' / DATA REQUIRED\n\nReasons:\n'+agentArray(cio.reasons).map(x=>'• '+x).join('\n')+'\n\nUnresolved questions:\n'+agentArray(cio.unresolved_questions).map(x=>'• '+x).join('\n')+'\n\nData required:\n'+agentArray(cio.data_required).map(x=>'• '+x).join('\n')+'\n\nThree-call model pilot only; no live market data was supplied.';
  await sql.query("INSERT INTO wealth_stock_advisor_reports (user_id,run_id,run_at,report_text,report_json) VALUES ($1,$2,now(),$3,$4::jsonb)",[uid,run.id,reportText,JSON.stringify(reportJson)]);
  await sql.query("UPDATE wealth_stock_advisor_runs SET status='completed' WHERE id=$1",[run.id]);
  const [savedRun]=await sql.query('SELECT id,run_key,run_at,status,agent_count FROM wealth_stock_advisor_runs WHERE id=$1',[run.id]),[savedCount]=await sql.query('SELECT count(*)::int AS count FROM wealth_stock_advisor_messages WHERE run_id=$1',[run.id]);
  return json(res,201,{saved:true,run:savedRun,messageCount:savedCount?.count||0,models:reportJson.models,decision:action});
 }catch(e){await sql.query("UPDATE wealth_stock_advisor_runs SET status='failed' WHERE id=$1",[run.id]).catch(()=>{});console.error('[stock-advisor-free-pilot]',e?.message||e);return json(res,e?.status||502,{error:e?.message||'Free-model pilot failed.'});}
}

export default async function handler(req,res){
 try{
  await schema();
  if(req.route==='stock-advisor/settings'&&req.method==='POST')return await saveAutoResearchSettings(req,res);
  if(req.route==='stock-advisor/free-run'&&req.method==='POST')return await runFreeModelPilot(req,res);
  if(req.route==='stock-advisor/settings'&&req.method==='GET'){const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});return json(res,200,await getAutoResearchSettings(uid))}
  if(req.method==='POST'){
   if(!validIngestSecret(req))return json(res,401,{error:'Valid advisor ingest token required.'});
   const input=await body(req);
   const reportJson=input.report_json??input.reportJson;
   if(!reportJson||typeof reportJson!=='object'||Array.isArray(reportJson))return json(res,400,{error:'report_json must be a JSON object.'});
   const reportText=String(input.report_text??input.reportText??reportJson.summary??'').trim();
   const messages=cleanMessages(input.messages??input.transcript); 
   const bullBearCases=cleanBullBearCases(input.bull_bear_cases??input.bullBearCases);
   if(!reportText&&!Array.isArray(reportJson.recommendations))return json(res,400,{error:'Provide report_text or structured recommendations.'});
   const runAt=input.run_at??input.runAt??null;
   if(runAt&&!Number.isFinite(Date.parse(runAt)))return json(res,400,{error:'run_at must be a valid ISO date.'});
   const suppliedRunKey=String(input.run_id??input.runId??'').trim();
   const runKey=(suppliedRunKey||randomUUID()).slice(0,160);
   const status=['running','completed','failed'].includes(String(input.status))?String(input.status):'completed';
   const requestedAgents=Number(input.agent_count??input.agentCount??3);
   const agentCount=Number.isInteger(requestedAgents)?Math.max(1,Math.min(12,requestedAgents)):3;
   const admins=await sql.query("SELECT id FROM wealth_users WHERE role='admin' LIMIT 1");
   if(!admins.length)return json(res,409,{error:'No admin account is configured for advisor reports.'});
   const uid=admins[0].id;
   const runs=await sql.query(
    'INSERT INTO wealth_stock_advisor_runs (user_id,run_key,run_at,status,agent_count) VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5) ON CONFLICT (user_id,run_key) DO UPDATE SET run_at=EXCLUDED.run_at,status=EXCLUDED.status,agent_count=EXCLUDED.agent_count RETURNING id,run_key,run_at,status,agent_count',
    [uid,runKey,runAt,status,agentCount]
   );
   const run=runs[0];
   for(const c of bullBearCases){
    await sql.query(
     'INSERT INTO wealth_stock_advisor_bull_bear_cases (run_id,ticker,stock_name,exchange,side,agent_key,agent_name,thesis,key_points,fundamental_evidence,technical_evidence,valuation,catalysts,risks,sources,confidence,target_price,time_horizon,verdict) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19) ON CONFLICT (run_id,ticker,side,agent_key) DO UPDATE SET stock_name=EXCLUDED.stock_name,exchange=EXCLUDED.exchange,agent_name=EXCLUDED.agent_name,thesis=EXCLUDED.thesis,key_points=EXCLUDED.key_points,fundamental_evidence=EXCLUDED.fundamental_evidence,technical_evidence=EXCLUDED.technical_evidence,valuation=EXCLUDED.valuation,catalysts=EXCLUDED.catalysts,risks=EXCLUDED.risks,sources=EXCLUDED.sources,confidence=EXCLUDED.confidence,target_price=EXCLUDED.target_price,time_horizon=EXCLUDED.time_horizon,verdict=EXCLUDED.verdict,updated_at=now()',
     [run.id,c.ticker,c.stock_name,c.exchange,c.side,c.agent_key,c.agent_name,c.thesis,JSON.stringify(c.key_points),JSON.stringify(c.fundamental_evidence),JSON.stringify(c.technical_evidence),JSON.stringify(c.valuation),JSON.stringify(c.catalysts),JSON.stringify(c.risks),JSON.stringify(c.sources),c.confidence,c.target_price,c.time_horizon,c.verdict]
    );
   }
   for(const m of messages){
    await sql.query(
     'INSERT INTO wealth_stock_advisor_messages (run_id,sequence_no,round_no,speaker,agent_key,message_type,content,summary,metadata,ticker,asset_type,evidence_refs,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,COALESCE($13::timestamptz,now())) ON CONFLICT (run_id,sequence_no) DO UPDATE SET round_no=EXCLUDED.round_no,speaker=EXCLUDED.speaker,agent_key=EXCLUDED.agent_key,message_type=EXCLUDED.message_type,content=EXCLUDED.content,summary=EXCLUDED.summary,metadata=EXCLUDED.metadata,ticker=EXCLUDED.ticker,asset_type=EXCLUDED.asset_type,evidence_refs=EXCLUDED.evidence_refs,created_at=EXCLUDED.created_at',
     [run.id,m.sequence_no,m.round_no,m.speaker,m.agent_key,m.message_type,m.content,m.summary,JSON.stringify(m.metadata),m.ticker,m.asset_type,JSON.stringify(m.evidence_refs),m.created_at]
    );
   }
   const saved=await sql.query(
    'INSERT INTO wealth_stock_advisor_reports (user_id,run_id,run_at,report_text,report_json) VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5::jsonb) ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO UPDATE SET run_at=EXCLUDED.run_at,report_text=EXCLUDED.report_text,report_json=EXCLUDED.report_json RETURNING id,run_id,run_at',
    [uid,run.id,runAt,reportText,JSON.stringify(reportJson)]
   );
   const job=await startJob('advisor-ingest');
   await finishJob(job,'succeeded',{runId:run.id,messages:messages.length,reportSaved:saved.length===1});
   const count=await sql.query('SELECT count(*)::int AS count FROM wealth_stock_advisor_messages WHERE run_id=$1',[run.id]);
   return json(res,201,{saved:true,run,report:saved[0],messageCount:count[0]?.count??0,bullBearCaseCount:bullBearCases.length});
  }
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  const uid=await sessionUser(req);if(!uid)return json(res,401,{error:'Sign in required'});
  const requestedRun=String(new URL(req.url,'https://wealth.local').searchParams.get('run_id')||'').trim();
  const settings=await getAutoResearchSettings(uid);
  const [runs,holdings]=await Promise.all([
   sql.query('SELECT id,run_key,run_at,status,agent_count,ticker,stock_name,asset_type,next_step,total_steps,last_completed_round,last_completed_speaker,last_error,created_at,updated_at FROM wealth_stock_advisor_runs WHERE user_id=$1 ORDER BY run_at DESC,created_at DESC',[uid]),
   sql.query("SELECT name,ticker,record_type,currency,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND record_type IN ('EQUITY','ETF','MUTUAL_FUND','FIXED_DEPOSIT','BOND','EPF','GOLD','SILVER') AND currency='INR' AND ticker IS NOT NULL ORDER BY name",[uid])
  ]);
  const run=(requestedRun?runs.find(r=>r.id===requestedRun):runs[0])||null;
  let report=null,messages=[],bullBearCases=[];
  if(run){
   const result=await Promise.all([
    sql.query('SELECT id,run_id,run_at,report_text,report_json FROM wealth_stock_advisor_reports WHERE user_id=$1 AND run_id=$2 LIMIT 1',[uid,run.id]),
    sql.query('SELECT id,sequence_no,round_no,speaker,agent_key,message_type,summary,metadata,ticker,asset_type,evidence_refs,created_at FROM wealth_stock_advisor_messages WHERE run_id=$1 ORDER BY sequence_no ASC',[run.id]),
    sql.query('SELECT id,ticker,stock_name,exchange,side,agent_key,agent_name,thesis,key_points,fundamental_evidence,technical_evidence,valuation,catalysts,risks,sources,confidence,target_price,time_horizon,verdict,created_at FROM wealth_stock_advisor_bull_bear_cases WHERE run_id=$1 ORDER BY ticker,side,agent_key',[run.id])
   ]);
   const storedReport=result[0][0]||null;
   if(storedReport){
    const safeJson={...(storedReport.report_json||{})};
    for(const key of ['committee_debate','debate_transcript','transcript','messages','turns','dialogue','raw_messages','full_messages']) delete safeJson[key];
    report={...storedReport,report_text:String(safeJson.summary||storedReport.report_text||'').slice(0,900),report_json:safeJson};
   }
   messages=result[1];bullBearCases=result[2];
  }
  if(requestedRun&&!run)return json(res,404,{error:'Advisor run not found.'});
  const research_health=await loadResearchHealth(uid,holdings);
  return json(res,200,{report,run,runs,messages,bull_bear_cases:bullBearCases,holdings,settings,research_health});
 }catch(e){
  if(e?.status===400)return json(res,400,{error:e.message});
  console.error('[wealth-stock-advisor]',e?.message||e);
  return json(res,500,{error:'Unable to process Stock Advisor data.'});
 }
}
