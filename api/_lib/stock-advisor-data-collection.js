const NSE_RSS_INDEX='https://www.nseindia.com/static/rss-feed';
const NSE_HOSTS=new Set(['www.nseindia.com','nsearchives.nseindia.com','nseindia.com']);
const timeout=ms=>AbortSignal.timeout(ms);
const clean=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const tag=(block,name)=>{const m=[...String(block||'').matchAll(/<([a-z]+)[^>]*>([\s\S]*?)<\/\1>/gi)].find(x=>x[1].toLowerCase()===String(name).toLowerCase());return m?clean(m[2]):''};
const allowed=url=>{try{return NSE_HOSTS.has(new URL(url).hostname)}catch{return false}};
async function getText(url,accept='application/rss+xml, application/xml, text/xml, text/html;q=0.9'){
 const r=await fetch(url,{headers:{'User-Agent':'MyWealthPersonalResearch/1.0','Accept':accept},signal:timeout(10000)});
 if(!r.ok)throw new Error('Provider HTTP '+r.status+' for '+new URL(url).hostname);
 return r.text();
}
async function nseFeeds(){
 const html=await getText(NSE_RSS_INDEX,'text/html');
 const links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)],feeds=[];
 for(const m of links){
  const label=clean(m[2]).toLowerCase();
  if(!/(announcement|financial result|board meeting|corporate information|press release|circular)/.test(label))continue;
  let url;try{url=new URL(m[1],NSE_RSS_INDEX).toString()}catch{continue}
  if(allowed(url)&&/rss|xml/i.test(url))feeds.push({url,label});
 }
 return feeds.slice(0,10);
}
export function cleanNseFeedItemMatches(text,ticker,name){
 const t=String(text||'').toLowerCase(),symbol=String(ticker||'').toLowerCase(),n=String(name||'').toLowerCase();
 return (symbol.length>1&&t.split(/[^a-z0-9&.-]+/).includes(symbol))||(n.length>=5&&t.includes(n));
}
async function collectMf({instrument,runId,db}){
 const scheme=String(instrument.price_source_symbol||instrument.symbol||'').trim();
 if(!/^\d{4,8}$/.test(scheme))return {ticker:instrument.symbol,status:'skipped',reason:'No saved AMFI scheme code'};
 const url='https://api.mfapi.in/mf/'+encodeURIComponent(scheme);
 const payload=await (await fetch(url,{headers:{Accept:'application/json'},signal:timeout(10000)})).json();
 const rows=(Array.isArray(payload?.data)?payload.data:[]).map(x=>{
  const p=String(x.date||'').split('-'),date=p.length===3?new Date(Date.UTC(+p[2],+p[1]-1,+p[0])):null,nav=Number(x.nav);
  return {date:date&&!Number.isNaN(date.getTime())?date.toISOString():null,nav};
 }).filter(x=>x.date&&Number.isFinite(x.nav)&&x.nav>0).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,5);
 if(!rows.length)throw new Error('MFAPI returned no valid dated NAV observations');
 const meta=payload.meta||{},title='Mutual fund NAV — '+String(meta.scheme_name||instrument.name||scheme);
 const evidence={provider:'MFAPI.in',scheme_code:scheme,scheme_name:meta.scheme_name||instrument.name||null,fund_house:meta.fund_house||null,scheme_type:meta.scheme_type||null,scheme_category:meta.scheme_category||null,observations:rows,currency:'INR',retrieved_at:new Date().toISOString(),verification_basis:'Valid dated NAV observations returned by MFAPI; scheme code taken from saved instrument pricing symbol.'};
 await db.query(`INSERT INTO wealth_stock_advisor_data_sources(run_id,instrument_id,ticker,asset_type,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
 VALUES($1,$2,$3,'mutual_fund','fund_nav',$4,$5,'MFAPI.in',$6::timestamptz,now(),$7,$8::jsonb,'verified')
 ON CONFLICT(ticker,url) DO UPDATE SET run_id=EXCLUDED.run_id,instrument_id=EXCLUDED.instrument_id,title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified'`,
 [runId,instrument.id,instrument.symbol,title,url,rows[0].date,'Latest NAV ₹'+rows[0].nav+' as of '+rows[0].date+'; '+rows.length+' observations stored.',JSON.stringify(evidence)]);
 return {ticker:instrument.symbol,status:'updated',source_type:'fund_nav',observations:rows.length};
}
async function collectEquityNews({instrument,runId,feeds,db}){
 const results=[];
 for(const feed of feeds){
  try{
   const xml=await getText(feed.url),items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
   for(const m of items){
    const title=tag(m[1],'title'),link=tag(m[1],'link'),description=tag(m[1],'description'),date=tag(m[1],'pubDate');
    if(!title||!link||!cleanNseFeedItemMatches(title+' '+description,instrument.symbol,instrument.name))continue;
    let url;try{url=new URL(link,feed.url).toString()}catch{continue}
    if(!allowed(url))continue;
    const stamp=Date.parse(date),published=Number.isFinite(stamp)?new Date(stamp).toISOString():null;
    const evidence={feed_url:feed.url,feed_label:feed.label,official_exchange_feed:true,content_kind:'rss_listing_only',retrieved_at:new Date().toISOString()};
    await db.query(`INSERT INTO wealth_stock_advisor_data_sources(run_id,instrument_id,ticker,asset_type,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
    VALUES($1,$2,$3,$4,'corporate_announcement',$5,$6,'NSE',$7::timestamptz,now(),$8,$9::jsonb,'unverified')
    ON CONFLICT(ticker,url) DO UPDATE SET run_id=EXCLUDED.run_id,instrument_id=EXCLUDED.instrument_id,title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='unverified'`,
    [runId,instrument.id,instrument.symbol,instrument.asset_class,title.slice(0,500),url,published,clean(description).slice(0,1800),JSON.stringify(evidence)]);
    results.push({ticker:instrument.symbol,status:'stored_unverified',title:title.slice(0,160)});
   }
  }catch(error){results.push({ticker:instrument.symbol,status:'feed_error',error:String(error?.message||error).slice(0,160)})}
 }
 return results;
}
export async function runStockAdvisorDataCollection(db){
 const [run]=await db.query('INSERT INTO wealth_stock_advisor_data_collection_runs(status) VALUES(\'running\') RETURNING id');
 const summary={instruments:0,nav_updated:0,announcements:0,failed:0,skipped:0,feeds:0,results:[]};
 try{
  const instruments=await db.query(`SELECT DISTINCT i.id,i.asset_class,i.symbol,i.name,i.price_source_symbol
   FROM wealth_instruments i JOIN wealth_holdings h ON h.instrument_id=i.id
   WHERE h.status='active' AND i.symbol IS NOT NULL AND i.price_source_symbol IS NOT NULL
   ORDER BY i.symbol LIMIT 250`);
  summary.instruments=instruments.length;
  const funds=instruments.filter(i=>i.asset_class==='indian_mutual_fund');
  const equities=instruments.filter(i=>i.asset_class==='indian_equity');
  let feeds=[];
  if(equities.length){try{feeds=await nseFeeds();summary.feeds=feeds.length}catch(e){summary.results.push({provider:'NSE feed discovery',status:'failed',error:String(e?.message||e).slice(0,180)})}}
  for(const instrument of funds){
   try{const r=await collectMf({instrument,runId:run.id,db});summary.results.push(r);if(r.status==='updated')summary.nav_updated++;else summary.skipped++}
   catch(e){summary.failed++;summary.results.push({ticker:instrument.symbol,status:'failed',error:String(e?.message||e).slice(0,180)})}
  }
  for(const instrument of equities){
   const rows=await collectEquityNews({instrument,runId:run.id,feeds,db});
   summary.results.push(...rows);summary.announcements+=rows.filter(x=>x.status==='stored_unverified').length;
   if(rows.some(x=>x.status==='feed_error'))summary.failed++;
  }
  const status=summary.failed?(summary.nav_updated||summary.announcements?'partial':'failed'):'succeeded';
  await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=$2,summary=$3::jsonb WHERE id=$1',[run.id,status,JSON.stringify(summary)]);
  return {run_id:run.id,status,...summary};
 }catch(error){
  await db.query('UPDATE wealth_stock_advisor_data_collection_runs SET finished_at=now(),status=\'failed\',error=$2,summary=$3::jsonb WHERE id=$1',[run.id,String(error?.message||error).slice(0,500),JSON.stringify(summary)]).catch(()=>{});
  throw error;
 }
}
