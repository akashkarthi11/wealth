import { sql, json, sessionUser, body, safeEqual } from '../_lib.js';
import { waitUntil } from '@vercel/functions';
import { createHash } from 'node:crypto';
import { collectMutualFundEvidence } from './stock-advisor-mfapi.js';
import { collectNseNews } from './stock-advisor-live-evidence.js';
import { collectTejHqEquityEvidence } from './stock-advisor-tejhq.js';
import { collectFincruxFinancials } from './stock-advisor-fincrux.js';

export const FREE_AI_MODEL = 'nvidia/nemotron-3.5-lightning-free';
export const DEBATE_SEQUENCE = Object.freeze([
  { step:0, round:1, side:'bull', type:'opening', speaker:'Bull Analyst' },
  { step:1, round:1, side:'bear', type:'opening', speaker:'Bear Analyst' },
  { step:2, round:2, side:'bull', type:'cross_examination', speaker:'Bull Analyst' },
  { step:3, round:2, side:'bear', type:'cross_examination', speaker:'Bear Analyst' },
  { step:4, round:3, side:'bull', type:'evidence_challenge', speaker:'Bull Analyst' },
  { step:5, round:3, side:'bear', type:'evidence_challenge', speaker:'Bear Analyst' },
  { step:6, round:4, side:'bull', type:'final_position', speaker:'Bull Analyst' },
  { step:7, round:4, side:'bear', type:'final_position', speaker:'Bear Analyst' },
  { step:8, round:5, side:'cio', type:'cio_decision', speaker:'Chief Investment Officer' }
]);

const ETF_GOLD = new Set(['TATAGOLD','GOLDBEES','GOLDIETF','GOLDCASE','HDFCGOLD','AXISGOLD','SETFGOLD','KOTAKGOLD','LICMFGOLD']);
const ETF_SILVER = new Set(['TATSILV','SILVERBEES','SILVERIETF','SILVERCASE','HDFCSILVER','AXISSILVER']);
const WORDS = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export function classifyAsset(input = {}) {
  const ticker = String(input.ticker || '').trim().toUpperCase();
  const record = String(input.record_type || '').trim().toUpperCase();
  const name = String(input.name || '').toLowerCase();
  if (ETF_GOLD.has(ticker) || /gold\s*(etf|exchange traded fund)/i.test(name)) return 'gold_etf';
  if (ETF_SILVER.has(ticker) || /silver\s*(etf|exchange traded fund)/i.test(name)) return 'silver_etf';
  if (record === 'ETF' || record.endsWith('_ETF')) return 'other_etf';
  if (record === 'MUTUAL_FUND') return 'mutual_fund';
  if (record === 'FIXED_DEPOSIT') return 'fixed_deposit';
  if (record === 'BOND' || record.includes('BOND')) return 'bond';
  if (record === 'EPF' || record === 'PENSION' || record === 'RETIREMENT') return 'retirement_asset';
  if (record === 'CASH' || record === 'BANK_BALANCE') return 'cash_balance';
  if (record === 'GOLD' || record === 'SILVER') return 'precious_metal';
  if (record === 'EQUITY' && String(input.currency || 'INR').toUpperCase() === 'INR') return 'indian_equity';
  if (record === 'US_EQUITY') return 'other_equity';
  return 'other_instrument';
}

export function extractMessageText(raw) {
  const text = String(raw || '').trim();
  try {
    const value = JSON.parse(text.replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,''));
    if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    if (value && typeof value.thesis === 'string' && value.thesis.trim()) return value.thesis.trim();
  } catch {}
  return text;
}

export function extractiveSummary(raw) {
  const text = extractMessageText(raw).replace(/\s+/g,' ').trim();
  if (!text) return 'The model returned no readable argument. The original response is retained for diagnosis and this debate step must be retried.';
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  let out = '';
  for (const sentence of sentences) {
    const next = (out ? out + ' ' : '') + sentence.trim();
    if (WORDS(next) > 76) break;
    out = next;
    if (WORDS(out) >= 25 && (out.match(/[.!?]/g) || []).length >= 2) break;
  }
  if (!out) out = text.slice(0, 650);
  return out.slice(0, 900);
}

export function validateSummary(summary, fullText) {
  const value = String(summary || '').replace(/\s+/g,' ').trim();
  if (WORDS(value) < 18 || WORDS(value) > 100 || value.length > 900) return false;
  const full = String(fullText || '');
  const numbers = value.match(/\b\d+(?:[,.]\d+)*(?:%|x|₹|Rs\.?|INR)?\b/g) || [];
  if (numbers.some(n => !full.includes(n))) return false;
  const urls = value.match(/https?:\/\/\S+/g) || [];
  if (urls.some(u => !full.includes(u))) return false;
  return true;
}

export function parseModelEnvelope(raw) {
  const full = String(raw || '');
  if (!full.trim()) throw new Error('AI Gateway returned an empty completion.');
  let parsed = null;
  try {
    const clean = full.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
    parsed = JSON.parse(clean);
  } catch {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { full, parsed:null, message:full, summary:extractiveSummary(full), parseValid:false };
  }
  const message = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : full;
  const proposed = typeof parsed.summary === 'string' ? parsed.summary : '';
  const summary = validateSummary(proposed, message) ? proposed.replace(/\s+/g,' ').trim() : extractiveSummary(message);
  return { full, parsed, message, summary, parseValid:!!(parsed.message && parsed.summary && validateSummary(proposed,message)) };
}

export function gatedDecision(decision, actionGate) {
  const value = String(decision || '').trim().toUpperCase().replace(/\s+/g,' ');
  if (actionGate !== 'EVIDENCE_READY') return 'DATA REQUIRED';
  return ['BUY','HOLD','SELL','DATA REQUIRED'].includes(value) ? value : 'DATA REQUIRED';
}

export function rolePrompt(step, prior, evidence, assetType) {
  const current = DEBATE_SEQUENCE[step];
  const own = current.side;
  const opponentSide = own === 'bull' ? 'bear' : 'bull';
  const priorText = side => {
    const m = prior.find(x => Number(x.sequence_no) === (side === 'bull' ? 0 : 1));
    return m ? extractMessageText(m.content) : 'No prior argument is available.';
  };
  const opponentRound1 = priorText(opponentSide);
  const ownRound1 = priorText(own);
  const opponentLatest = [...prior].reverse().find(m => String(m.agent_key || '').startsWith(opponentSide));
  const ownLatest = [...prior].reverse().find(m => String(m.agent_key || '').startsWith(own));
  const evidenceText = JSON.stringify(evidence);
  const assetRule = assetType === 'gold_etf' || assetType === 'silver_etf' || assetType === 'other_etf'
    ? 'ETF TEMPLATE: analyse underlying exposure, tracking error, expense ratio, liquidity/spread, NAV versus market price, underlying commodity/benchmark drivers and concentration. Do NOT discuss operating-company revenue, management, mining operations or company debt.'
    : assetType === 'mutual_fund'
      ? 'MUTUAL FUND TEMPLATE: analyse mandate, benchmark, portfolio composition, expense ratio, tracking difference, concentration, liquidity and manager/process risk. Do not analyse it as an operating company.'
      : assetType === 'fixed_deposit' || assetType === 'bond'
        ? 'FIXED INCOME TEMPLATE: analyse issuer/credit risk, yield, maturity, duration, liquidity, reinvestment and rate risk. Do not use equity valuation multiples.'
        : assetType === 'retirement_asset'
          ? 'RETIREMENT TEMPLATE: analyse contribution, allocation, lock-in, liquidity, policy and long-horizon risk. Do not use operating-company metrics.'
          : 'EQUITY TEMPLATE: analyse business quality, financial statements, valuation, governance, sector exposure, market data and technical evidence.';
  const common = 'Investment: ' + evidence.instrument.name + ' (' + evidence.instrument.ticker + '). Asset type: ' + assetType + '. ' + assetRule +
    '\nEVIDENCE PACK (only source of current facts): ' + evidenceText +
    '\nEvidence rules: distinguish VERIFIED FACTS, UNVERIFIED THIRD-PARTY DATA, ASSUMPTIONS and OPINIONS. Unverified values may be discussed only as leads and must never be presented as verified facts or used alone to justify an action. Cite only evidence_ref IDs actually present in the pack. No invented figures, dates, URLs, sources, ratios, technical indicators or broker data. State stale/missing data. If evidence is missing, say so. MTF is UNKNOWN unless explicit current verified broker evidence is present; never assume zero.';
  const output = 'Return one JSON object only with: message (complete analyst argument, 250-450 words), summary (simple English, 2-4 sentences, 40-70 words, strictly derived from message), key_evidence (array of evidence_ref IDs or empty), main_risk (string), current_position (BUY/HOLD/SELL/DATA REQUIRED), opponent_argument_challenged (string). Summary may not add claims, numbers or sources absent from message.';
  let task = '';
  if (step === 0) task = 'ROUND 1 OPENING: independently make the strongest honest bullish case. You have not seen the Bear argument. Do not speculate as fact.';
  if (step === 1) task = 'ROUND 1 OPENING: independently make the strongest honest bearish case. You have not seen the Bull argument. Do not speculate as fact.';
  if (step === 2) task = 'ROUND 2 CROSS-EXAMINATION: challenge the Bear Analyst\'s actual opening argument below. Quote or accurately identify specific claims, test assumptions, and explain what evidence would confirm or refute them. Do not merely repeat your opening.';
  if (step === 3) task = 'ROUND 2 CROSS-EXAMINATION: challenge the Bull Analyst\'s actual opening argument below. Identify specific unsupported claims and explain what would disprove them.';
  if (step === 4) task = 'ROUND 3 EVIDENCE CHALLENGE: examine the verified evidence pack and both analysts\' latest arguments. Identify unsupported claims, contradictions, stale facts and missing evidence. Reconsider your own thesis where warranted.';
  if (step === 5) task = 'ROUND 3 EVIDENCE CHALLENGE: independently examine the verified evidence pack and both analysts\' latest arguments. Identify unsupported claims, contradictions, stale facts and missing evidence. Reconsider your own thesis where warranted.';
  if (step === 6) task = 'ROUND 4 FINAL POSITION: provide your revised or defended final position. Acknowledge the strongest valid counterargument and state what would change your view.';
  if (step === 7) task = 'ROUND 4 FINAL POSITION: provide your revised or defended final position. Acknowledge the strongest valid counterargument and state what would change your view.';
  const opponent = step === 2 || step === 3 ? opponentRound1 : opponentLatest ? extractMessageText(opponentLatest.content) : opponentRound1;
  const ownPrior = step >= 2 && ownLatest ? extractMessageText(ownLatest.content) : ownRound1;
  return { system:'You are the ' + current.speaker + ' in a disciplined Indian investment committee. Be rigorous, independent and willing to change your mind. Never invent evidence. ' + output,
    user:common + '\n' + task + '\nYOUR PRIOR ARGUMENT:\n' + ownPrior + '\nOPPONENT ARGUMENT TO ADDRESS:\n' + opponent +
      (step >= 4 ? '\nOTHER RECENT DEBATE MESSAGES:\n' + prior.map(m => m.speaker + ': ' + extractMessageText(m.content)).join('\n\n') : '') };
}

export function cioPrompt(prior, evidence, assetType) {
  const debate = prior.map(m => 'ROUND ' + m.round_no + ' / ' + m.speaker + ':\n' + extractMessageText(m.content)).join('\n\n');
  const output = 'Return JSON only with message (complete adjudication, 300-500 words), summary (2-4 simple English sentences, 40-70 words), decision (BUY/HOLD/SELL/DATA REQUIRED), main_reason, biggest_risk, missing_evidence (array), change_conditions (array), confidence (0-100), key_evidence (array of evidence_ref IDs). The summary must explicitly include final decision, main reason, biggest risk, missing evidence and what would change the decision. Never create facts or citations.';
  return { system:'You are the Chief Investment Officer. Adjudicate the complete four-round debate, not just the opening arguments. Be decisive but evidence-led. Reject unsupported claims and acknowledge valid counterarguments. ' + output,
    user:'Investment: ' + evidence.instrument.name + ' (' + evidence.instrument.ticker + '). Asset type: ' + assetType +
      '\nEvidence gate: ' + evidence.action_gate + '. Missing evidence: ' + JSON.stringify(evidence.missing_evidence_types) +
      '\nEvidence pack: ' + JSON.stringify(evidence) +
      '\nAll eight analyst messages:\n' + debate +
      '\nIf essential evidence is missing, the decision MUST be DATA REQUIRED. BUY is prohibited unless evidence gate is EVIDENCE_READY and the thesis is supported. Include portfolio concentration only where data exists; MTF only if verified broker evidence exists. ' };
}

async function reserveFreeModelSlot() {
  // NVIDIA's free Nemotron route is limited to five requests/minute per region.
  // Reserve one shared slot in Postgres so parallel runs cannot all hit the provider together.
  await sql.query("CREATE TABLE IF NOT EXISTS wealth_stock_advisor_ai_rate_limit (id smallint PRIMARY KEY CHECK (id=1), next_allowed_at timestamptz NOT NULL)");
  const acquired = await sql.query(`
    INSERT INTO wealth_stock_advisor_ai_rate_limit(id,next_allowed_at)
    VALUES(1,now()+interval '13 seconds')
    ON CONFLICT(id) DO UPDATE SET next_allowed_at=now()+interval '13 seconds'
      WHERE wealth_stock_advisor_ai_rate_limit.next_allowed_at<=now()
    RETURNING id
  `);
  if (acquired.length) return;
  const [slot] = await sql.query("SELECT GREATEST(1000,ceil(extract(epoch FROM (next_allowed_at-now()))*1000)::int) AS wait_ms FROM wealth_stock_advisor_ai_rate_limit WHERE id=1");
  throw Object.assign(new Error('Nemotron free-tier request pacing; retrying when the shared provider slot is available.'), {
    code:'AI_DEFERRED', retryAfterMs:Number(slot?.wait_ms||13000)
  });
}

async function callGroqFreeModel(messages,maxTokens=2200) {
  const key=String(process.env.GROQ_API_KEY||'').trim();
  const zeroRetention=String(process.env.GROQ_ZERO_DATA_RETENTION_CONFIRMED||'').trim().toLowerCase()==='true';
  if(!key||!zeroRetention)return null;
  const model='openai/gpt-oss-20b';
  const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({model,messages,temperature:0.2,max_completion_tokens:maxTokens,response_format:{type:'json_object'}}),
    signal:AbortSignal.timeout(30000)
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('Groq free-tier error '+response.status+': '+String(payload?.error?.message||payload?.message||'provider unavailable').slice(0,180));
  const choice=payload?.choices?.[0],raw=choice?.message?.content;
  if(typeof raw!=='string'||!raw.trim())throw new Error('Groq returned an empty completion.');
  return {raw,usage:payload?.usage||{},finish_reason:choice?.finish_reason||null,provider:'Groq',provider_key:'groq-free',model,provider_label:'Groq Free'};
}

async function callFreeModel(messages,maxTokens=2200) {
  const key=String(process.env.AI_GATEWAY_API_KEY||'').trim();
  let primaryError=null;
  if(key) {
    try {
      await reserveFreeModelSlot();
      const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
        method:'POST',
        headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
        body:JSON.stringify({model:FREE_AI_MODEL,messages,temperature:0.2,max_tokens:maxTokens,reasoning:{effort:'none'},response_format:{type:'json_object'}}),
        signal:AbortSignal.timeout(30000)
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok) {
        const retryHeader=String(response.headers.get('retry-after')||'').trim();
        const retryMs=retryHeader
          ?(Number.isFinite(Number(retryHeader))?Number(retryHeader)*1000:Math.max(1000,Date.parse(retryHeader)-Date.now()))
          :(response.status===429?30000:0);
        throw Object.assign(new Error('Free Nemotron Gateway error '+response.status+': '+String(payload?.error?.message||payload?.message||'provider unavailable').slice(0,180)),{
          code:response.status===429?'AI_PROVIDER_RATE_LIMIT':'AI_GATEWAY_ERROR',
          retryAfterMs:Math.max(1000,retryMs||30000)
        });
      }
      const choice=payload?.choices?.[0],raw=choice?.message?.content;
      if(typeof raw!=='string'||!raw.trim())throw new Error('Empty Nemotron response; finish='+String(choice?.finish_reason||'unknown')+', completion_tokens='+Number(payload?.usage?.completion_tokens||0));
      return {raw,usage:payload?.usage||{},finish_reason:choice?.finish_reason||null,provider:'Vercel AI Gateway',provider_key:'nemotron-free',model:FREE_AI_MODEL,provider_label:'Nemotron Free'};
    } catch(error) {
      primaryError=error;
      console.warn('[stock-advisor-debate:primary-ai]',error?.message||error);
    }
  }
  try {
    const fallback=await callGroqFreeModel(messages,maxTokens);
    if(fallback)return fallback;
  } catch(error) {
    console.warn('[stock-advisor-debate:groq-fallback]',error?.message||error);
    if(primaryError)throw primaryError;
    throw error;
  }
  if(primaryError)throw primaryError;
  throw new Error('No free AI provider is configured. Configure AI_GATEWAY_API_KEY or configure Groq with GROQ_API_KEY and verified Zero Data Retention.');
}

async function retrySummary(messageText) {
  try {
    const result=await callFreeModel([
      {role:'system',content:'You are a strict extractive summarizer. Return JSON only with one field: summary. Write 2-4 sentences, 40-70 words, simple English. Use only claims, figures and sources explicitly present in the supplied original response. Add no new facts, numbers, dates or sources.'},
      {role:'user',content:'Summarize this original analyst response without changing its meaning:\n'+String(messageText||'').slice(0,14000)}
    ],320);
    const parsed=JSON.parse(String(result.raw||'').trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,''));
    if(parsed&&validateSummary(parsed.summary,messageText))return {summary:String(parsed.summary).replace(/\s+/g,' ').trim(),usage:result.usage||{},fallback:false};
  } catch(error) {
    console.warn('[stock-advisor-debate:summary-retry]',error?.message||error);
  }
  return {summary:extractiveSummary(messageText),usage:{},fallback:true};
}

async function loadEvidence(uid, holding, assetType, runId) {
  const ticker = String(holding.ticker || '').toUpperCase();
  const [instrumentRows, sourceRows, portfolioRows] = await Promise.all([
    sql.query('SELECT i.id AS instrument_id,i.symbol,i.name,i.currency,p.price,p.as_of,p.source,p.fetched_at,p.fx_to_inr FROM wealth_instruments i LEFT JOIN LATERAL (SELECT price,as_of,source,fetched_at,fx_to_inr FROM wealth_instrument_prices WHERE instrument_id=i.id ORDER BY as_of DESC LIMIT 5) p ON true WHERE upper(i.symbol)=upper($1)',[ticker]),
    sql.query('SELECT id,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status FROM wealth_stock_advisor_research_sources WHERE (run_id=$1 OR run_id IS NULL) AND upper(ticker)=upper($2) ORDER BY (run_id=$1) DESC,retrieved_at DESC LIMIT 40',[runId,ticker]),
    sql.query("SELECT record_type,currency,count(*)::int AS holdings,sum(coalesce(current_value,0))::numeric AS value FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' GROUP BY record_type,currency ORDER BY value DESC",[uid])
  ]);
  const now = Date.now(), evidenceRefs = [], prices = [];
  for (const row of instrumentRows) if (row.price != null) {
    const fresh = row.fetched_at && now - Date.parse(row.fetched_at) <= 36 * 3600000 && now >= Date.parse(row.fetched_at);
    prices.push({ instrument_id:row.instrument_id, price:row.price, currency:row.currency, as_of:row.as_of, fetched_at:row.fetched_at, source:row.source, status:fresh?'fresh':'stale' });
    evidenceRefs.push({ type:'market_price', id:row.instrument_id, source:row.source || 'stored market feed', as_of:row.as_of, status:fresh?'verified':'stale' });
  }
  const sources = sourceRows.map(s => {
    const freshnessTimestamp = s.source_type === 'fund_nav' ? (s.published_at || s.retrieved_at) : s.retrieved_at;
    const age = (now - Date.parse(freshnessTimestamp)) / 3600000;
    const maxAgeHours = s.source_type === 'fund_nav' ? 24 * 7
      : (s.source_type === 'market_price' || s.source_type === 'technical_indicator') ? 36
      : (s.source_type === 'financial_statement' || s.source_type === 'exchange_filing' || s.source_type === 'company_filing') ? 24 * 400
      : s.source_type === 'news' ? 24 * 14 : 24 * 45;
    const fresh = s.verification_status === 'verified' && age >= 0 && age <= maxAgeHours;
    evidenceRefs.push({type:s.source_type,id:s.id,title:s.title,url:s.url,status:fresh?'verified':s.verification_status,as_of:s.published_at || s.retrieved_at});
    return {...s, verification_status:fresh?'verified':(age>24*45?'stale':s.verification_status)};
  });
  const verifiedTypes = new Set(sources.filter(s=>s.verification_status==='verified').map(s=>s.source_type));
  if (prices.some(p=>p.status==='fresh') || sources.some(s=>s.source_type==='fund_nav'&&s.verification_status==='verified')) verifiedTypes.add('market_price');
  const required = assetType === 'gold_etf' || assetType === 'silver_etf' || assetType === 'other_etf'
    ? ['market_price','expense_ratio','tracking_error','liquidity_spread','nav_premium_discount','underlying_exposure','commodity_drivers']
    : assetType === 'mutual_fund'
      ? ['market_price','portfolio_composition','expense_ratio','benchmark_tracking']
      : assetType === 'fixed_deposit' || assetType === 'bond'
        ? ['issuer_credit','yield_maturity','liquidity']
        : assetType === 'retirement_asset'
          ? ['allocation','contribution_history','liquidity_policy']
          : ['market_price','financial_statement','technical_indicator'];
  const missing = required.filter(type=>!verifiedTypes.has(type));
  const actionGate = missing.length ? 'DATA_REQUIRED' : 'EVIDENCE_READY';
  const value = Number(holding.current_value || 0);
  const concentration = null;
  return {
    captured_at:new Date(now).toISOString(),
    instrument:{ticker,name:String(holding.name||ticker),currency:holding.currency||'INR',record_type:holding.record_type,quantity:holding.quantity,current_value:holding.current_value,balance_as_of:holding.balance_as_of},
    asset_type:assetType, prices, sources, portfolio_snapshot:{holding_count:portfolioRows.reduce((s,r)=>s+Number(r.holdings||0),0),value_by_record_type:portfolioRows,holding_value_share_pct:concentration,mtf_exposure:'UNKNOWN — no current verified broker MTF record was supplied to this debate'},
    verified_evidence_types:[...verifiedTypes],missing_evidence_types:missing,action_gate:actionGate,evidence_refs:evidenceRefs
  };
}

function scheduleWorker(req, runId, delayMs=0) {
  // Invoke the worker in-process. Calling this same Vercel Function over HTTP is
  // rejected by Vercel's recursive-request guard (HTTP 508), so no self-fetch.
  const secret = String(process.env.CRON_SECRET || '').trim();
  const headers = {};
  if (secret.length>=16) headers.authorization='Bearer '+secret;
  else if (req?.headers?.cookie) headers.cookie=String(req.headers.cookie);
  const delay = Math.max(0,Math.min(30000,Number(delayMs)||0));
  const task = new Promise(resolve=>setTimeout(resolve,delay)).then(async ()=>{
    const workerReq = {
      method:'POST',
      url:'/api/stock-advisor/debate/worker',
      route:'stock-advisor/debate/worker',
      headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({run_id:runId})); }
    };
    const workerRes = {
      statusCode:200, headers:{}, body:'',
      setHeader(name,value) { this.headers[name]=value; },
      end(value='') { this.body=String(value); return this; }
    };
    await handleWorker(workerReq,workerRes);
    if (workerRes.statusCode>=400) console.warn('[stock-advisor-debate:worker]',workerRes.statusCode,workerRes.body);
  }).catch(error=>console.warn('[stock-advisor-debate:worker]',error?.message||error));
  try { waitUntil(task); } catch (error) { console.warn('[stock-advisor-debate:waitUntil]',error?.message||error); }
}

async function startDebate(req,res) {
  const uid=await sessionUser(req); if(!uid) return json(res,401,{error:'Sign in required'});
  const input=await body(req),ticker=String(input.ticker||'').trim().toUpperCase();
  const idempotency=String(input.idempotency_key||input.idempotencyKey||'').trim();
  if(!/^[A-Z0-9&.-]{1,30}$/.test(ticker)) return json(res,400,{error:'Choose a valid saved investment ticker.'});
  if(!/^[A-Za-z0-9_-]{12,100}$/.test(idempotency)) return json(res,400,{error:'A valid idempotency_key is required.'});
  const holdings=await sql.query("SELECT name,ticker,record_type,currency,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND category='INVESTMENT' AND upper(ticker)=upper($2) ORDER BY CASE WHEN record_type='EQUITY' THEN 0 ELSE 1 END LIMIT 1",[uid,ticker]);
  if(!holdings.length) return json(res,404,{error:'That investment is not in your saved portfolio.'});
  const holding=holdings[0],assetType=classifyAsset(holding);
  const runKey=('debate:'+ticker+':'+idempotency).slice(0,160);
  const rows=await sql.query("INSERT INTO wealth_stock_advisor_runs (user_id,run_key,run_at,status,agent_count,ticker,stock_name,asset_type,idempotency_key,total_steps,next_step,progress_json) VALUES ($1,$2,now(),'queued',9,$3,$4,$5,$6,9,0,'{}'::jsonb) ON CONFLICT (user_id,run_key) DO NOTHING RETURNING id,run_key,run_at,status,agent_count,ticker,stock_name,asset_type,next_step,total_steps",[uid,runKey,ticker,holding.name,assetType,idempotency]);
  const run=rows[0] || (await sql.query('SELECT id,run_key,run_at,status,agent_count,ticker,stock_name,asset_type,next_step,total_steps FROM wealth_stock_advisor_runs WHERE user_id=$1 AND run_key=$2',[uid,runKey]))[0];
  if (!run) return json(res,500,{error:'Could not create debate run.'});
  await sql.query("INSERT INTO wealth_stock_advisor_run_jobs (run_id,stage,status,step_no,step_attempts,max_attempts,idempotency_key,payload) VALUES ($1,'debate','pending',0,0,3,$2,$3::jsonb) ON CONFLICT (run_id,stage) DO NOTHING",[run.id,'debate:'+run.id,JSON.stringify({ticker,asset_type:assetType})]);
  if (run.status === 'partially_completed' || run.status === 'failed') {
    await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status='pending',step_attempts=0,available_at=now(),last_error=NULL,locked_at=NULL,updated_at=now() WHERE run_id=$1 AND stage='debate' AND status='failed'",[run.id]);
    await sql.query("UPDATE wealth_stock_advisor_runs SET status='running',last_error=NULL,updated_at=now() WHERE id=$1",[run.id]);
  }
  // Bulk schedule submissions are queued first; the authenticated queue pump dispatches one run at a time.
  // Direct single-ticker requests still start immediately.
  if (run.status !== 'completed' && !String(input.schedule_execution_id||'').trim()) scheduleWorker(req,run.id);
  return json(res,202,{saved:true,queued:true,run,messageCount:0,progress:{completed:0,total:9,current_round:1,current_speaker:'Bull Analyst'}});
}

export function cioReady(prior) { return Array.isArray(prior) && Array.from({length:8},(_,i)=>prior.some(m=>Number(m.sequence_no)===i)).every(Boolean); }

async function processStep(req, runId) {
  const claimed=await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status='running',locked_at=now(),attempts=attempts+1,step_attempts=step_attempts+1,updated_at=now() WHERE id=(SELECT id FROM wealth_stock_advisor_run_jobs WHERE run_id=$1 AND stage='debate' AND available_at<=now() AND step_no<9 AND step_attempts<max_attempts AND (status='pending' OR (status='running' AND locked_at<now()-interval '90 seconds')) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,step_no,step_attempts,max_attempts",[runId]);
  if(!claimed.length) return {idle:true};
  const job=claimed[0],step=Number(job.step_no),plan=DEBATE_SEQUENCE[step];
  const runs=await sql.query('SELECT id,user_id,ticker,stock_name,asset_type,status,progress_json FROM wealth_stock_advisor_runs WHERE id=$1',[runId]);
  if(!runs.length) throw new Error('Debate run no longer exists.');
  const run=runs[0];
  let evidence=run.progress_json&&typeof run.progress_json==='object'?run.progress_json.evidence_package:null;
  const prior=await sql.query('SELECT id,sequence_no,round_no,speaker,agent_key,message_type,content,summary,metadata,evidence_refs FROM wealth_stock_advisor_messages WHERE run_id=$1 ORDER BY sequence_no',[runId]);
  const existing=prior.find(m=>String(m.metadata?.idempotency_key||'')==='debate:'+runId+':'+step);
  if(existing) {
    if(step===8) {
      const savedEnvelope=parseModelEnvelope(existing.content);
      if(!evidence) throw new Error('The shared evidence snapshot is missing; resume from the first research step.');
      const savedDecision=gatedDecision(savedEnvelope.parsed?.decision,evidence.action_gate);
      await advanceStep(job.id,runId,step,plan,existing,{decision:savedDecision,summary:existing.summary,parsed:savedEnvelope.parsed||{},evidenceGate:evidence.action_gate});
    } else await advanceStep(job.id,runId,step,plan,existing);
    return {advanced:true,step};
  }
  const [holdingRows]=await Promise.all([sql.query("SELECT name,ticker,record_type,currency,quantity,current_value,balance_as_of FROM wealth_positions WHERE user_id=$1 AND upper(ticker)=upper($2) AND category='INVESTMENT' LIMIT 1",[run.user_id,run.ticker])]);
  if(!holdingRows.length) throw new Error('Saved investment disappeared; refusing to research an unknown asset.');
  if(!evidence){
    if(step!==0) throw new Error('The shared evidence snapshot is missing; resume from the first research step.');
    const refreshes={};
    // First trust reusable, fresh verified DB evidence. Only call free providers
    // when the required evidence is absent or stale in the existing tables.
    evidence=await loadEvidence(run.user_id,holdingRows[0],run.asset_type,run.id);
    if(run.asset_type==='mutual_fund' && evidence.missing_evidence_types.includes('market_price')) {
      refreshes.mutual_fund=await collectMutualFundEvidence({ticker:run.ticker,name:run.stock_name,runId:run.id,db:sql});
      evidence=await loadEvidence(run.user_id,holdingRows[0],run.asset_type,run.id);
    }
    if(run.asset_type==='indian_equity') {
      const needsMarket=evidence.missing_evidence_types.includes('market_price');
      const needsTechnical=evidence.missing_evidence_types.includes('technical_indicator');
      if(needsMarket || needsTechnical) {
        refreshes.tejhq=await collectTejHqEquityEvidence({ticker:run.ticker,name:run.stock_name,runId:run.id,db:sql});
        // Re-read after persistence so the debate consumes the stored, verified rows,
        // not an in-memory provider response.
        evidence=await loadEvidence(run.user_id,holdingRows[0],run.asset_type,run.id);
      } else {
        refreshes.tejhq={status:'skipped',reason:'Fresh verified market price and technical evidence already exist in the database.'};
      }
      // Financial statements are enriched from Fincrux only when the optional free key
      // is configured. The provider payload remains unverified until official filings
      // corroborate it, so it cannot unlock a BUY decision by itself.
      if(evidence.missing_evidence_types.includes('financial_statement')) {
        refreshes.fincrux=await collectFincruxFinancials({instrument:{symbol:run.ticker,name:run.stock_name},db:sql});
        evidence=await loadEvidence(run.user_id,holdingRows[0],run.asset_type,run.id);
      }
      // NSE announcement discovery remains an independent, low-cost refresh.
      refreshes.nse_news=await collectNseNews({ticker:run.ticker,name:run.stock_name,runId:run.id,db:sql});
      evidence=await loadEvidence(run.user_id,holdingRows[0],run.asset_type,run.id);
    }
    evidence.provider_refreshes=refreshes;
    evidence.captured_at=new Date().toISOString();
    evidence.package_hash=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    await sql.query("UPDATE wealth_stock_advisor_runs SET progress_json=jsonb_set(coalesce(progress_json,'{}'::jsonb),'{evidence_package}',$2::jsonb,true),updated_at=now() WHERE id=$1",[run.id,JSON.stringify(evidence)]);
  }
  if(step===8 && !cioReady(prior)) throw new Error('CIO adjudication is blocked until all eight analyst messages are persisted.');
  const prompt=step===8?cioPrompt(prior,evidence,run.asset_type):rolePrompt(step,prior,evidence,run.asset_type);
  const model=await callFreeModel([{role:'system',content:prompt.system},{role:'user',content:prompt.user}]);
  const envelope=parseModelEnvelope(model.raw);
  const parsed=envelope.parsed||{};
  const speaker=plan.speaker + ' · ' + model.provider_label;
  const decision=step===8?gatedDecision(parsed.decision,evidence.action_gate):null;
  const cioSummary=step===8?[
    'Decision: '+decision+'. Main reason: '+String(parsed.main_reason||'Available evidence is insufficient for a stronger action.').slice(0,140),
    'Biggest risk: '+String(parsed.biggest_risk||'Key assumptions may not hold.').slice(0,120),
    'Missing evidence: '+(Array.isArray(parsed.missing_evidence)&&parsed.missing_evidence.length?parsed.missing_evidence.slice(0,2).join('; '):evidence.missing_evidence_types.join('; ')||'No additional gap was identified.').slice(0,130),
    'This decision changes if: '+(Array.isArray(parsed.change_conditions)&&parsed.change_conditions.length?parsed.change_conditions.slice(0,2).join('; '):'Verified updated evidence resolves the stated gaps.').slice(0,130)
  ].join(' ').slice(0,900):null;
  const summaryRetry=step<8&&!envelope.parseValid?await retrySummary(envelope.message):{summary:envelope.summary,usage:{},fallback:false};
  const summaryForStorage=step===8?cioSummary:summaryRetry.summary;
  const summaryUsage=summaryRetry.usage||{};
  const messageType=plan.type;
  const meta={
    model:model.model,provider:model.provider,finish_reason:model.finish_reason,usage:{prompt_tokens:Number(model.usage?.prompt_tokens||0)+Number(summaryUsage.prompt_tokens||0),completion_tokens:Number(model.usage?.completion_tokens||0)+Number(summaryUsage.completion_tokens||0),total_tokens:Number(model.usage?.total_tokens||0)+Number(summaryUsage.total_tokens||0)},
    parse_valid:envelope.parseValid,summary_retry_used:step<8&&!envelope.parseValid,summary_fallback:step===8?!Boolean(parsed.summary):summaryRetry.fallback,
    key_evidence:Array.isArray(parsed.key_evidence)?parsed.key_evidence.filter(x=>evidence.evidence_refs.some(r=>r.id===x)).slice(0,12):[],
    main_risk:String(parsed.main_risk||parsed.biggest_risk||'Not separately stated in the model response.').slice(0,700),
    current_position:step===8?decision:String(parsed.current_position||'DATA REQUIRED').toUpperCase(),
    opponent_argument_challenged:String(parsed.opponent_argument_challenged||'').slice(0,1200),
    missing_evidence:Array.isArray(parsed.missing_evidence)?parsed.missing_evidence.slice(0,20):evidence.missing_evidence_types,
    change_conditions:Array.isArray(parsed.change_conditions)?parsed.change_conditions.slice(0,12):[],
    evidence_gate:evidence.action_gate,missing_evidence_types:evidence.missing_evidence_types,
    evidence_refs:evidence.evidence_refs,evidence_package_hash:evidence.package_hash,idempotency_key:'debate:'+runId+':'+step
  };
  if(envelope.full.length>30000) throw new Error('Model response exceeded the safe message storage limit; retrying with a shorter response.');
  const full = envelope.full;
  const saved=await sql.query("INSERT INTO wealth_stock_advisor_messages (run_id,sequence_no,round_no,speaker,agent_key,message_type,content,summary,metadata,ticker,asset_type,evidence_refs,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,now()) ON CONFLICT DO NOTHING RETURNING id",[runId,step,plan.round,speaker,plan.side+'-'+model.provider_key,messageType,full,summaryForStorage,JSON.stringify(meta),run.ticker,run.asset_type,JSON.stringify(evidence.evidence_refs),'debate:'+runId+':'+step]);
  if(!saved.length) {
    const [found]=await sql.query('SELECT id FROM wealth_stock_advisor_messages WHERE run_id=$1 AND sequence_no=$2',[runId,step]);
    if(!found) throw new Error('Message persistence conflict; no saved message found.');
  }
  await sql.query("INSERT INTO wealth_stock_advisor_agent_outputs (run_id,ticker,agent_key,stage,round_no,provider,model,status,output,input_hash,prompt_tokens,completion_tokens,started_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8::jsonb,$9,$10,$11,now(),now())",[runId,run.ticker,plan.side+'-'+model.provider_key,messageType,plan.round,model.provider,model.model,JSON.stringify({summary:summaryForStorage,metadata:meta}),String(step)+':'+run.ticker,Number(model.usage?.prompt_tokens||0),Number(model.usage?.completion_tokens||0)]);
  const [message]=await sql.query('SELECT id,sequence_no,round_no,speaker,agent_key,message_type,summary,metadata,evidence_refs,created_at FROM wealth_stock_advisor_messages WHERE run_id=$1 AND sequence_no=$2',[runId,step]);
  await advanceStep(job.id,runId,step,plan,message,step===8?{decision,summary:summaryForStorage,parsed,evidenceGate:evidence.action_gate}:null);
  return {advanced:true,step,decision};
}

async function advanceStep(jobId,runId,step,plan,message,cio=null) {
  const next=step+1;
  await sql.query("UPDATE wealth_stock_advisor_runs SET next_step=$2,last_completed_round=$3,last_completed_speaker=$4,status='running',updated_at=now(),last_error=NULL WHERE id=$1",[runId,next,plan.round,plan.speaker]);
  if(step===6 || step===7) {
    const side=step===6?'bull':'bear';
    const [run]=await sql.query('SELECT ticker,stock_name FROM wealth_stock_advisor_runs WHERE id=$1',[runId]);
    const meta=message.metadata&&typeof message.metadata==='object'?message.metadata:{};
    await sql.query("INSERT INTO wealth_stock_advisor_bull_bear_cases (run_id,ticker,stock_name,exchange,side,agent_key,agent_name,thesis,key_points,fundamental_evidence,technical_evidence,valuation,catalysts,risks,sources,confidence,verdict) VALUES ($1,$2,$3,'NSE',$4,$5,$6,$7,$8::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$9,$10) ON CONFLICT (run_id,ticker,side,agent_key) DO UPDATE SET thesis=EXCLUDED.thesis,key_points=EXCLUDED.key_points,confidence=EXCLUDED.confidence,verdict=EXCLUDED.verdict,updated_at=now()",
      [runId,run.ticker,run.stock_name,side,message.agent_key||side+'-nemotron-free',message.speaker||plan.speaker+' · Nemotron Free',message.summary,JSON.stringify(Array.isArray(meta.key_evidence)?meta.key_evidence:[]),Number.isFinite(Number(meta.confidence))?Number(meta.confidence):null,String(meta.current_position||'DATA REQUIRED')]);
  }
  if(next===9 && cio) {
    const runRows=await sql.query('SELECT user_id,ticker,stock_name,asset_type,run_at FROM wealth_stock_advisor_runs WHERE id=$1',[runId]),run=runRows[0];
    const summary=String(cio.summary||'The CIO could not provide a validated conclusion. DATA REQUIRED: review missing evidence before acting.');
    const decision=cio.decision;
    const reportJson={summary,decision,recommendations:[{ticker:run.ticker,symbol:run.ticker,company:run.stock_name,asset_type:run.asset_type,action:decision,reason:cio.parsed.main_reason||summary,risk:cio.parsed.biggest_risk||'Not stated',confidence:cio.parsed.confidence??null}],cio:{decision,main_reason:cio.parsed.main_reason||'',biggest_risk:cio.parsed.biggest_risk||'',missing_evidence:cio.parsed.missing_evidence||[],change_conditions:cio.parsed.change_conditions||[],confidence:cio.parsed.confidence??null},debate:{rounds:4,analyst_messages:8,complete:true},evidence_gate:cio.evidenceGate||'DATA_REQUIRED'};
    await sql.query("INSERT INTO wealth_stock_advisor_reports (user_id,run_id,run_at,report_text,report_json) VALUES ($1,$2,now(),$3,$4::jsonb) ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO UPDATE SET run_at=EXCLUDED.run_at,report_text=EXCLUDED.report_text,report_json=EXCLUDED.report_json",[run.user_id,runId,summary,JSON.stringify(reportJson)]);
    await sql.query("UPDATE wealth_stock_advisor_runs SET status='completed',next_step=9,updated_at=now(),last_error=NULL WHERE id=$1",[runId]);
    await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status='completed',locked_at=NULL,completed_at=now(),step_no=9,step_attempts=0,last_error=NULL,updated_at=now() WHERE id=$1",[jobId]);
  } else {
    await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status='pending',locked_at=NULL,step_no=$2,step_attempts=0,available_at=now(),updated_at=now(),last_error=NULL WHERE id=$1",[jobId,next]);
  }
}

async function handleWorker(req,res) {
  const secret=String(process.env.CRON_SECRET||'').trim();
  const internal=secret.length>=16 && safeEqual(String(req.headers.authorization||''),'Bearer '+secret);
  const uid=internal?null:await sessionUser(req);
  if(!internal&&!uid) return json(res,401,{error:'Sign in required'});
  const input=await body(req),runId=String(input.run_id||input.runId||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(runId)) return json(res,400,{error:'A valid run_id is required.'});
  const [owned]=internal
    ? await sql.query('SELECT id,status FROM wealth_stock_advisor_runs WHERE id=$1',[runId])
    : await sql.query('SELECT id,status FROM wealth_stock_advisor_runs WHERE id=$1 AND user_id=$2',[runId,uid]);
  if(!owned) return json(res,404,{error:'Debate run not found.'});
  if(owned.status==='completed') return json(res,200,{ok:true,status:'completed'});
  try {
    const result=await processStep(req,runId);
    const [job]=await sql.query("SELECT status,step_no,step_attempts,last_error,available_at FROM wealth_stock_advisor_run_jobs WHERE run_id=$1 AND stage='debate'",[runId]);
    // The progress endpoint is the poll-driven continuation trigger. Do not chain
    // another worker invocation from this background task; that would outlive the
    // current UI polling cycle and can exceed the Hobby function duration.
    return json(res,202,{ok:true,status:job?.status||owned.status,step:job?.step_no||0,result});
  } catch(error) {
    const [job]=await sql.query("SELECT id,step_no,step_attempts,max_attempts FROM wealth_stock_advisor_run_jobs WHERE run_id=$1 AND stage='debate'",[runId]);
    const deferred=error?.code==='AI_DEFERRED';
    const exhausted=!deferred && job && Number(job.step_attempts)>=Number(job.max_attempts);
    const [savedCount]=await sql.query('SELECT count(*)::int AS count FROM wealth_stock_advisor_messages WHERE run_id=$1',[runId]);
    const finalStatus=Number(savedCount?.count||0)>0?'partially_completed':'failed';
    const delay=deferred
      ? Math.min(30000,Math.max(1000,Number(error.retryAfterMs)||13000))
      : Math.min(60000,Math.max(1000,Number(error?.retryAfterMs)||Math.pow(2,Math.max(0,Number(job?.step_attempts||1)-1))*3000));
    await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status=$2,step_attempts=CASE WHEN $5 THEN GREATEST(step_attempts-1,0) ELSE step_attempts END,locked_at=NULL,available_at=now()+($3::text||' milliseconds')::interval,last_error=$4,updated_at=now() WHERE run_id=$1 AND stage='debate'",[runId,exhausted?'failed':'pending',delay,deferred?null:String(error?.message||error).slice(0,1000),deferred]);
    await sql.query("UPDATE wealth_stock_advisor_runs SET status=$2,last_error=$3,updated_at=now() WHERE id=$1",[runId,exhausted?finalStatus:'running',deferred?null:String(error?.message||error).slice(0,1000)]);
    console.error('[stock-advisor-debate:step]',runId,job?.step_no,error?.message||error);
    return json(res,202,{ok:false,status:exhausted?finalStatus:deferred?'queued':'retrying',step:job?.step_no||0,error:exhausted?'A debate step failed after its retry limit.':deferred?'Waiting for the shared AI provider slot.':'A transient error occurred; the step will be retried.'});
  }
}

async function resumeDebate(req,res) {
  const uid=await sessionUser(req); if(!uid) return json(res,401,{error:'Sign in required'});
  const input=await body(req),runId=String(input.run_id||input.runId||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(runId)) return json(res,400,{error:'A valid run_id is required.'});
  const [run]=await sql.query('SELECT id,status,next_step FROM wealth_stock_advisor_runs WHERE id=$1 AND user_id=$2',[runId,uid]);
  if(!run) return json(res,404,{error:'Debate run not found.'});
  if(run.status==='completed') return json(res,200,{ok:true,status:'completed'});
  await sql.query("UPDATE wealth_stock_advisor_run_jobs SET status='pending',step_no=$2,step_attempts=0,available_at=now(),locked_at=NULL,last_error=NULL,updated_at=now() WHERE run_id=$1 AND stage='debate'",[runId,Number(run.next_step||0)]);
  await sql.query("UPDATE wealth_stock_advisor_runs SET status='running',last_error=NULL,updated_at=now() WHERE id=$1",[runId]);
  scheduleWorker(req,runId);
  return json(res,202,{ok:true,resumed:true,run_id:runId,next_step:Number(run.next_step||0)});
}

async function pumpQueue(req,res) {
  const uid=await sessionUser(req); if(!uid) return json(res,401,{error:'Sign in required'});
  const url=new URL(req.url,'https://wealth.local'),executionId=String(url.searchParams.get('execution_id')||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(executionId)) return json(res,400,{error:'A valid execution_id is required.'});
  const [execution]=await sql.query('SELECT id,result_json,status FROM wealth_stock_advisor_schedule_runs WHERE id=$1 AND user_id=$2',[executionId,uid]);
  if(!execution) return json(res,404,{error:'Research execution not found.'});
  let entries=execution.result_json;
  if(typeof entries==='string'){try{entries=JSON.parse(entries)}catch{entries=[]}}
  const runIds=[...new Set((Array.isArray(entries)?entries:[]).map(x=>String(x?.run_id||'')).filter(x=>/^[0-9a-f-]{36}$/i.test(x)))];
  if(!runIds.length) return json(res,200,{ok:true,dispatched:false,done:true,counts:{total:0,completed:0,failed:0,active:0}});
  const [next]=await sql.query(`
    SELECT r.id FROM wealth_stock_advisor_runs r
    JOIN wealth_stock_advisor_run_jobs j ON j.run_id=r.id AND j.stage='debate'
    WHERE r.user_id=$1 AND r.id=ANY($2::uuid[]) AND r.status NOT IN ('completed','failed','partially_completed')
      AND NOT EXISTS (SELECT 1 FROM wealth_stock_advisor_run_jobs active WHERE active.run_id=ANY($2::uuid[]) AND active.stage='debate' AND active.status='running' AND active.locked_at>now()-interval '90 seconds')
      AND ((j.status='pending' AND j.available_at<=now())
        OR (j.status='running' AND (j.locked_at IS NULL OR j.locked_at<now()-interval '90 seconds')))
    ORDER BY j.available_at,r.run_at,r.id LIMIT 1
  `,[uid,runIds]);
  if(next) scheduleWorker(req,next.id);
  const states=await sql.query(`
    SELECT r.status,count(*)::int AS count FROM wealth_stock_advisor_runs r
    WHERE r.user_id=$1 AND r.id=ANY($2::uuid[]) GROUP BY r.status
  `,[uid,runIds]);
  const counts={total:runIds.length,completed:0,failed:0,active:0};
  for(const row of states){
    if(row.status==='completed')counts.completed+=Number(row.count);
    else if(row.status==='failed'||row.status==='partially_completed')counts.failed+=Number(row.count);
    else counts.active+=Number(row.count);
  }
  return json(res,200,{ok:true,dispatched:!!next,done:counts.completed+counts.failed===counts.total,counts});
}

async function getProgress(req,res) {
  const uid=await sessionUser(req); if(!uid) return json(res,401,{error:'Sign in required'});
  const url=new URL(req.url,'https://wealth.local'),runId=String(url.searchParams.get('run_id')||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(runId)) return json(res,400,{error:'A valid run_id is required.'});
  const [run]=await sql.query('SELECT id,run_key,run_at,status,agent_count,ticker,stock_name,asset_type,next_step,total_steps,last_completed_round,last_completed_speaker,last_error,created_at,updated_at FROM wealth_stock_advisor_runs WHERE id=$1 AND user_id=$2',[runId,uid]);
  if(!run) return json(res,404,{error:'Debate run not found.'});
  const [messages,jobRows,reportRows]=await Promise.all([
    sql.query('SELECT id,sequence_no,round_no,speaker,agent_key,message_type,summary,metadata,evidence_refs,created_at FROM wealth_stock_advisor_messages WHERE run_id=$1 ORDER BY sequence_no',[runId]),
    sql.query("SELECT status,step_no,step_attempts,max_attempts,last_error,available_at,locked_at FROM wealth_stock_advisor_run_jobs WHERE run_id=$1 AND stage='debate'",[runId]),
    sql.query('SELECT report_json,run_at FROM wealth_stock_advisor_reports WHERE run_id=$1',[runId])
  ]);
  const job=jobRows[0]||null;
  const availableAt=job?.available_at?Date.parse(job.available_at):0;
  const staleRunning=job?.status==='running'&&(!job.locked_at||Date.now()-Date.parse(job.locked_at)>90000);
  if(run.status!=='completed' && job && (staleRunning || (job.status==='pending' && availableAt<=Date.now()))) scheduleWorker(req,runId,staleRunning?0:0);
  return json(res,200,{run,progress:{completed:messages.length,total:9,current_step:job?.step_no||run.next_step||0,current_round:Math.min(4,Math.floor((job?.step_no||run.next_step||0)/2)+1),last_completed_round:run.last_completed_round,last_completed_speaker:run.last_completed_speaker,job_status:job?.status||run.status,retry_count:job?.step_attempts||0,last_error:job?.last_error||run.last_error||null},messages,report:reportRows[0]||null});
}

export default async function handler(req,res) {
  try {
    if (!sql) return json(res,503,{error:'Database is not configured.'});
    if (req.route==='stock-advisor/debate/start' || req.route==='stock-advisor/free-run') return await startDebate(req,res);
    if (req.route==='stock-advisor/debate/worker' && req.method==='POST') return await handleWorker(req,res);
    if (req.route==='stock-advisor/debate/resume' && req.method==='POST') return await resumeDebate(req,res);
    if (req.route==='stock-advisor/debate/queue' && req.method==='GET') return await pumpQueue(req,res);
    if (req.route==='stock-advisor/debate/progress' && req.method==='GET') return await getProgress(req,res);
    return json(res,405,{error:'Method not allowed'});
  } catch(error) {
    console.error('[stock-advisor-debate]',error?.message||error);
    return json(res,error?.status||500,{error:error?.message||'Unable to process the debate request.'});
  }
}
