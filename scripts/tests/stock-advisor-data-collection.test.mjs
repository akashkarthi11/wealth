import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNseFeedItemMatches } from '../../api/_lib/stock-advisor-data-collection.js';
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
