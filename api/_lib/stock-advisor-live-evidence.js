const NSE_RSS_INDEX = 'https://www.nseindia.com/static/rss-feed';
const ALLOWED_HOSTS = new Set(['www.nseindia.com','nsearchives.nseindia.com','nseindia.com']);
const timeout = ms => AbortSignal.timeout(ms);
const decode = s => String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
function tag(block,name){const m=block.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)<\\/'+name+'>','i'));return m?decode(m[1]):''}
function hostAllowed(url){try{return ALLOWED_HOSTS.has(new URL(url).hostname)}catch{return false}}
async function getText(url){const r=await fetch(url,{headers:{'User-Agent':'MyWealthResearch/1.0 (personal investment research)','Accept':'application/rss+xml, application/xml, text/xml, text/html;q=0.9'},signal:timeout(9000)});if(!r.ok)throw new Error('NSE feed HTTP '+r.status);return await r.text()}
async function discoverFeeds(){
 const html=await getText(NSE_RSS_INDEX),links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
 const found=[];
 for(const m of links){const label=decode(m[2]).toLowerCase(),href=m[1];if(!/(announcement|financial result|board meeting|corporate information|press release|circular)/.test(label))continue;let url;try{url=new URL(href,NSE_RSS_INDEX).toString()}catch{continue}if(hostAllowed(url)&&/rss|xml/i.test(url))found.push({url,label})}
 return found.slice(0,8);
}
function matchesCompany(text,ticker,name){const t=String(text||'').toLowerCase(),n=String(name||'').toLowerCase(),symbol=String(ticker||'').toLowerCase();return (symbol.length>1&&t.split(/[^a-z0-9&.-]+/).includes(symbol))||(n.length>=5&&t.includes(n))}
export async function collectNseNews({ticker,name,runId,db}){
 const result={provider:'NSE RSS',ticker,fetched_at:new Date().toISOString(),stored:0,feeds_checked:0,errors:[],status:'no_results'};
 try{
  const feeds=await discoverFeeds();result.feeds_checked=feeds.length;
  for(const feed of feeds){
   try{
    const xml=await getText(feed.url),items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    for(const item of items){
     const block=item[1],title=tag(block,'title'),link=tag(block,'link'),description=tag(block,'description'),date=tag(block,'pubDate'),combined=title+' '+description;
     if(!title||!link||!matchesCompany(combined,ticker,name))continue;
     const parsed=Date.parse(date),published=Number.isFinite(parsed)?new Date(parsed).toISOString():null;
     const url=new URL(link,feed.url).toString();if(!hostAllowed(url))continue;
     const excerpt=description.slice(0,1800),evidence={feed_url:feed.url,feed_label:feed.label,official_exchange_feed:true,content_kind:'rss_item',retrieved_at:result.fetched_at};
     const saved=await db.query("INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status) VALUES ($1,$2,'corporate_announcement',$3,$4,'NSE',$5::timestamptz,now(),$6,$7::jsonb,'verified') ON CONFLICT (run_id,ticker,url) DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified' RETURNING id",[runId,ticker,title.slice(0,500),url,published,excerpt,JSON.stringify(evidence)]);
     if(saved.length)result.stored++;
    }
   }catch(e){result.errors.push(String(e?.message||e).slice(0,160))}
  }
  result.status=result.stored?'ok':(feeds.length?'no_matching_items':'feed_discovery_failed');
 }catch(e){result.errors.push(String(e?.message||e).slice(0,200));result.status='unavailable'}
 return result;
}
