import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEBATE_SEQUENCE, classifyAsset, extractMessageText, extractiveSummary,
  parseModelEnvelope, validateSummary, gatedDecision, rolePrompt, cioReady
} from '../../api/_lib/stock-advisor-debate.js';

test('debate sequence is exactly eight analyst turns followed by one CIO adjudication', () => {
  assert.equal(DEBATE_SEQUENCE.length, 9);
  assert.deepEqual(DEBATE_SEQUENCE.slice(0,8).map(x=>[x.round,x.side,x.type]),[
    [1,'bull','opening'],[1,'bear','opening'],
    [2,'bull','cross_examination'],[2,'bear','cross_examination'],
    [3,'bull','evidence_challenge'],[3,'bear','evidence_challenge'],
    [4,'bull','final_position'],[4,'bear','final_position']
  ]);
  assert.deepEqual(DEBATE_SEQUENCE[8],{step:8,round:5,side:'cio',type:'cio_decision',speaker:'Chief Investment Officer'});
});

test('TATAGOLD is classified as a gold ETF despite legacy EQUITY labels', () => {
  assert.equal(classifyAsset({ticker:'TATAGOLD',record_type:'EQUITY',currency:'INR'}),'gold_etf');
});
test('TATSILV is classified as a silver ETF despite legacy EQUITY labels', () => {
  assert.equal(classifyAsset({ticker:'TATSILV',record_type:'EQUITY',currency:'INR'}),'silver_etf');
});
test('asset-specific classification distinguishes equities, ETFs, funds and fixed income', () => {
  assert.equal(classifyAsset({ticker:'RELIANCE',record_type:'EQUITY',currency:'INR'}),'indian_equity');
  assert.equal(classifyAsset({ticker:'ABCETF',record_type:'ETF',currency:'INR'}),'other_etf');
  assert.equal(classifyAsset({record_type:'MUTUAL_FUND'}),'mutual_fund');
  assert.equal(classifyAsset({record_type:'FIXED_DEPOSIT'}),'fixed_deposit');
  assert.equal(classifyAsset({record_type:'BOND'}),'bond');
  assert.equal(classifyAsset({record_type:'EPF'}),'retirement_asset');
});

const prior=[
  {sequence_no:0,round_no:1,speaker:'Bull Analyst',agent_key:'bull-nemotron-free',content:JSON.stringify({message:'The Bull opening argument says recurring demand supports durable growth and operating leverage.'})},
  {sequence_no:1,round_no:1,speaker:'Bear Analyst',agent_key:'bear-nemotron-free',content:JSON.stringify({message:'The Bear opening argument says valuation risk and weak cash conversion could overwhelm growth.'})},
  {sequence_no:2,round_no:2,speaker:'Bull Analyst',agent_key:'bull-nemotron-free',content:JSON.stringify({message:'Bull responds that cash conversion should be tested over a full cycle.'})},
  {sequence_no:3,round_no:2,speaker:'Bear Analyst',agent_key:'bear-nemotron-free',content:JSON.stringify({message:'Bear replies that margin assumptions remain unverified.'})}
];
const evidence={instrument:{ticker:'TEST',name:'Test Ltd'},action_gate:'DATA_REQUIRED',missing_evidence_types:['financial_statement'],evidence_refs:[]};

test('Bull cross-examination receives the Bear opening argument verbatim', () => {
  const prompt=rolePrompt(2,prior,evidence,'indian_equity');
  assert.match(prompt.user,/valuation risk and weak cash conversion could overwhelm growth/);
  assert.match(prompt.user,/challenge the Bear Analyst/);
});
test('Bear cross-examination receives the Bull opening argument verbatim', () => {
  const prompt=rolePrompt(3,prior,evidence,'indian_equity');
  assert.match(prompt.user,/recurring demand supports durable growth and operating leverage/);
  assert.match(prompt.user,/challenge the Bull Analyst/);
});
test('Round 3 prompts include both sides latest arguments and evidence pack', () => {
  const bull=rolePrompt(4,prior,evidence,'indian_equity');
  const bear=rolePrompt(5,prior,evidence,'indian_equity');
  for(const prompt of [bull,bear]){
    assert.match(prompt.user,/EVIDENCE PACK/);
    assert.match(prompt.user,/margin assumptions remain unverified/);
    assert.match(prompt.user,/full cycle/);
  }
});
test('Round 4 final positions require acknowledging the valid counterargument', () => {
  assert.match(rolePrompt(6,prior,evidence,'indian_equity').system,/willing to change your mind/);
  assert.match(rolePrompt(6,prior,evidence,'indian_equity').user,/Acknowledge the strongest valid counterargument/);
  assert.match(rolePrompt(7,prior,evidence,'indian_equity').user,/what would change your view/);
});
test('CIO is blocked until all eight distinct analyst sequence numbers are persisted', () => {
  assert.equal(cioReady(prior),false);
  const eight=[...prior,{sequence_no:4},{sequence_no:5},{sequence_no:6},{sequence_no:7}];
  assert.equal(cioReady(eight),true);
  assert.equal(cioReady(eight.slice(0,7)),false);
});

test('summary validation rejects unsupported numbers and URLs', () => {
  const full='The company reported 12 percent growth and the report is available at https://example.com/report. It also described a stable cash conversion cycle over the latest reporting period.';
  assert.equal(validateSummary('The company reported 12 percent growth and described a stable cash conversion cycle over the latest reporting period.',full),true);
  assert.equal(validateSummary('The company reported 28 percent growth and described a stable cash conversion cycle over the latest reporting period.',full),false);
  assert.equal(validateSummary('The company reported 12 percent growth; details are at https://fake.example/report. The latest reporting period showed a stable cash conversion cycle.',full),false);
});
test('full raw model completion is preserved independently of its summary', () => {
  const raw=JSON.stringify({message:'A complete analyst argument with a cautious view of growth, valuation and evidence gaps.',summary:'The analyst sees potential growth but remains cautious because valuation and evidence are not yet sufficient for a confident decision.'});
  const parsed=parseModelEnvelope(raw);
  assert.equal(parsed.full,raw);
  assert.equal(parsed.parsed.message,'A complete analyst argument with a cautious view of growth, valuation and evidence gaps.');
  assert.equal(parsed.summary,'The analyst sees potential growth but remains cautious because valuation and evidence are not yet sufficient for a confident decision.');
});
test('malformed non-empty model response is retained and receives an extractive fallback', () => {
  const raw='The analyst sees growth potential. However, current valuation evidence is missing. The key risk is execution.';
  const parsed=parseModelEnvelope(raw);
  assert.equal(parsed.full,raw);
  assert.equal(parsed.parseValid,false);
  assert.ok(parsed.summary.length>0);
  assert.match(parsed.summary,/valuation evidence is missing/);
});
test('empty model output is rejected for retry instead of persisted as a completed turn', () => {
  assert.throws(()=>parseModelEnvelope('   '),/empty completion/);
});
test('missing essential evidence forces DATA REQUIRED and never BUY', () => {
  assert.equal(gatedDecision('BUY','DATA_REQUIRED'),'DATA REQUIRED');
  assert.equal(gatedDecision('SELL','DATA_REQUIRED'),'DATA REQUIRED');
  assert.equal(gatedDecision('BUY','EVIDENCE_READY'),'BUY');
  assert.equal(gatedDecision('HOLD','EVIDENCE_READY'),'HOLD');
});

const route=readFileSync(new URL('../../api/_routes/stock-advisor.js',import.meta.url),'utf8');
const debate=readFileSync(new URL('../../api/_lib/stock-advisor-debate.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../migrations/0041_stock_advisor_four_round_debate.sql',import.meta.url),'utf8');

test('frontend API query selects summaries and never selects full message content',()=>{
  assert.match(route,/SELECT id,sequence_no,round_no,speaker,agent_key,message_type,summary,metadata,ticker,asset_type,evidence_refs,created_at FROM wealth_stock_advisor_messages/);
  assert.doesNotMatch(route,/SELECT[^;]*content[^;]*FROM wealth_stock_advisor_messages/);
});
test('normal debate cards render summary text, not message content',()=>{
  const fn=app.slice(app.indexOf('function advisorMessageHtml'),app.indexOf('function advisorLegacyMessages'));
  assert.match(fn,/m\.summary/);
  assert.doesNotMatch(fn,/m\.content|m\.message\?\?|m\.text\?\?/);
});
test('full response storage is unchanged and separate from summary',()=>{
  assert.match(debate,/const full = envelope\.full;/);
  assert.match(debate,/content,summary,metadata/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT ''/);
  assert.doesNotMatch(migration,/UPDATE wealth_stock_advisor_messages\s+SET content=/i);
});
test('worker persists idempotency keys and retries resumable steps',()=>{
  assert.match(debate,/idempotency_key/);
  assert.match(debate,/step_attempts<max_attempts/);
  assert.match(debate,/available_at=now\(\)/);
  assert.match(debate,/partially_completed/);
});
test('summary generation has a bounded Nemotron retry and extractive fallback',()=>{
  assert.match(debate,/async function retrySummary\(messageText\)/);
  assert.match(debate,/return \{summary:extractiveSummary\(messageText\),usage:\{\},fallback:true\}/);
  assert.match(debate,/summary_retry_used/);
});
test('CIO summary contains decision, reason, risk, missing evidence and change conditions',()=>{
  assert.match(debate,/Decision: '\+decision/);
  assert.match(debate,/Biggest risk:/);
  assert.match(debate,/Missing evidence:/);
  assert.match(debate,/This decision changes if:/);
});
test('asset prompts prohibit operating-company analysis for ETFs',()=>{
  assert.match(debate,/Do NOT discuss operating-company revenue, management, mining operations or company debt/);
  assert.match(debate,/tracking error, expense ratio, liquidity\/spread, NAV versus market price/);
});
