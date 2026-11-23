import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNseFeedItemMatches, planCollection, TASKS, foldTaskResult, newSummary, runStatus } from '../../api/_lib/stock-advisor-data-collection.js';
import { collectNseNewsBatch } from '../../api/_lib/stock-advisor-live-evidence.js';

test('NSE matching requires a symbol token or meaningful company-name match',()=>{
 assert.equal(cleanNseFeedItemMatches('ABC Ltd board meeting','ABC','ABC Limited'),true);
 assert.equal(cleanNseFeedItemMatches('ABCDEF announces results','ABC','Other Company'),false);
 assert.equal(cleanNseFeedItemMatches('Example Industries quarterly result','EXMPL','Example Industries'),true);
});

test('NSE RSS parser decodes CDATA, matches the saved ticker and stores the listing as unverified', async () => {
 const originalFetch=globalThis.fetch;
 const inserts=[];
 globalThis.fetch=async url=>{
  const body=String(url).includes('Online_announcements.xml')
   ? '<rss><channel><item><title><![CDATA[RELIANCE Board Meeting]]></title><link>https://www.nseindia.com/example-announcement</link><description><![CDATA[Reliance Industries Ltd board meeting]]></description><pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>'
   : '<rss><channel></channel></rss>';
  return new Response(body,{status:200,headers:{'Content-Type':'application/rss+xml'}});
 };
 try {
  const batch=await collectNseNewsBatch({
   instruments:[{symbol:'RELIANCE',name:'Reliance Industries Ltd'}],
   db:{query:async(sql,params)=>{inserts.push({sql,params});return [];}}
  });
  assert.equal(batch.feeds_checked,6);
  assert.equal(batch.stored,1);
  assert.equal(batch.results[0].status,'stored_unverified');
  assert.equal(inserts.length,1);
  assert.equal(inserts[0].params[0],'RELIANCE');
  assert.equal(inserts[0].params[2],'RELIANCE Board Meeting');
  assert.equal(inserts[0].params[6].includes('rss_listing_only'),true);
 } finally {
  globalThis.fetch=originalFetch;
 }
});

test('the collection plan queues one audited NSE XBRL item per active Indian equity before secondary Fincrux', async () => {
 const originalKey=process.env.FINCRUX_API_KEY;
 delete process.env.FINCRUX_API_KEY;
 const db={query:async sql=>{
  if(sql.includes('i.price_source_symbol IS NOT NULL')) return [
   {id:1,asset_class:'indian_equity',symbol:'RELIANCE',name:'Reliance Industries Limited',price_source_symbol:'RELIANCE'},
   {id:2,asset_class:'indian_equity',symbol:'HDFCBANK',name:'HDFC Bank Limited',price_source_symbol:'HDFCBANK'},
   {id:3,asset_class:'indian_equity',symbol:'HDFCBANK',name:'HDFC Bank Limited duplicate instrument',price_source_symbol:'HDFCBANK'}
  ];
  if(sql.includes("i.asset_class='indian_equity'")) return [
   {id:1,asset_class:'indian_equity',symbol:'RELIANCE',name:'Reliance Industries Limited',price_source_symbol:'RELIANCE'},
   {id:2,asset_class:'indian_equity',symbol:'HDFCBANK',name:'HDFC Bank Limited',price_source_symbol:'HDFCBANK'},
   {id:3,asset_class:'indian_equity',symbol:'HDFCBANK',name:'HDFC Bank Limited duplicate instrument',price_source_symbol:'HDFCBANK'},
   {id:4,asset_class:'indian_equity',symbol:'NO_PRICE',name:'No Price Source Limited',price_source_symbol:null}
  ];
  return [];
 }};
 try {
  const plan=await planCollection(db);
  const xbrl=plan.tasks.filter(x=>x.task==='nse_xbrl');
  assert.equal(xbrl.length,3);
  assert.deepEqual(xbrl.map(x=>x.payload.instrument.symbol).sort(),['HDFCBANK','NO_PRICE','RELIANCE']);
  assert.ok(xbrl.every(x=>x.min_budget_ms===26000));
  assert.ok(plan.tasks.findIndex(x=>x.task==='nse_xbrl') < plan.tasks.findIndex(x=>x.task==='fincrux_skip'));
  assert.equal(TASKS.nse_xbrl.provider,'NSE XBRL');
  assert.equal(plan.tasks.some(x=>x.task==='verify'),false,'legacy Fincrux period matching is no longer scheduled');
  assert.match(TASKS.verify.name,/disabled/,'old queued verify items fail closed for compatibility');
 } finally {
  if(originalKey===undefined) delete process.env.FINCRUX_API_KEY; else process.env.FINCRUX_API_KEY=originalKey;
 }
});

test('missing NSE statements keep the collection run visibly incomplete', () => {
 const summary=newSummary();
 summary.instruments=1;
 summary.market_data_updated=1;
 foldTaskResult(summary,'nse_xbrl',{status:'no_announcement',detail:[]});
 assert.equal(summary.financials_missing,1);
 assert.equal(runStatus(summary),'partial');
 foldTaskResult(summary,'nse_xbrl',{status:'verified',detail:[]});
 assert.equal(summary.financials_verified,1);
});
