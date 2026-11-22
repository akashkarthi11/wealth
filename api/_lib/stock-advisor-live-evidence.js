const NSE_HOSTS = new Set(['www.nseindia.com','nsearchives.nseindia.com','nseindia.com']);
const NSE_FEEDS = Object.freeze([
  { label:'Announcements', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml' },
  { label:'Financial results', source_type:'financial_statement', url:'https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml' },
  { label:'Annual reports', source_type:'financial_statement', url:'https://nsearchives.nseindia.com/content/RSS/Annual_Reports.xml' },
  { label:'Board meetings', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml' },
  { label:'Shareholding patterns', source_type:'exchange_filing', url:'https://nsearchives.nseindia.com/content/RSS/Shareholding_Pattern.xml' },
  { label:'Corporate actions', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Corporate_action.xml' }
]);
const timeout = ms => AbortSignal.timeout(ms);
const clean = value => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/<[^>]+>/g,' ')
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const tag = (block,name) => {
  const match = String(block || '').match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)</'+name+'>','i'));
  return match ? clean(match[1]) : '';
};
const hostAllowed = url => {
  try { return NSE_HOSTS.has(new URL(url).hostname); } catch { return false; }
};

export function cleanNseFeedItemMatches(text,ticker,name) {
  const value=String(text||'').toLowerCase(),symbol=String(ticker||'').toLowerCase(),company=String(name||'').toLowerCase();
  return (symbol.length>1&&value.split(/[^a-z0-9&.-]+/).includes(symbol))||(company.length>=5&&value.includes(company));
}

async function getFeed(url) {
  const response=await fetch(url,{
    headers:{'User-Agent':'MyWealthPersonalResearch/1.0','Accept':'application/rss+xml, application/xml, text/xml'},
    signal:timeout(10000)
  });
  if(!response.ok)throw new Error('NSE RSS HTTP '+response.status);
  return response.text();
}

async function saveItem({runId,ticker,sourceType,title,url,published,excerpt,feed,db}) {
  const evidence={feed_url:feed.url,feed_label:feed.label,official_exchange_feed:true,content_kind:'rss_listing_only',retrieved_at:new Date().toISOString()};
  if(runId) {
    await db.query(\`
      INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      VALUES($1,$2,$3,$4,$5,'NSE',$6::timestamptz,now(),$7,$8::jsonb,'unverified')
      ON CONFLICT(run_id,ticker,url) DO UPDATE SET
        title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),
        excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='unverified'
    \`,[runId,ticker,sourceType,title.slice(0,500),url,published,excerpt.slice(0,1800),JSON.stringify(evidence)]);
  } else {
    await db.query(\`
      INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      VALUES(NULL,$1,$2,$3,$4,'NSE',$5::timestamptz,now(),$6,$7::jsonb,'unverified')
      ON CONFLICT(ticker,url) WHERE run_id IS NULL DO UPDATE SET
        source_type=EXCLUDED.source_type,title=EXCLUDED.title,published_at=EXCLUDED.published_at,
        retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='unverified'
    \`,[ticker,sourceType,title.slice(0,500),url,published,excerpt.slice(0,1800),JSON.stringify(evidence)]);
  }
}

export async function collectNseNewsBatch({instruments=[],runId=null,db}={}) {
  const list=(Array.isArray(instruments)?instruments:[]).filter(x=>x?.symbol);
  const results=new Map(list.map(x=>[String(x.symbol).toUpperCase(),{ticker:String(x.symbol).toUpperCase(),status:'no_matching_items',stored:0,errors:[]} ]));
  const batch={provider:'NSE RSS',fetched_at:new Date().toISOString(),feeds_checked:0,stored:0,errors:[],results:[]};
  for(const feed of NSE_FEEDS) {
    try {
      const xml=await getFeed(feed.url);
      batch.feeds_checked++;
      const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
      for(const item of items) {
        const block=item[1],title=tag(block,'title'),link=tag(block,'link'),description=tag(block,'description'),date=tag(block,'pubDate');
        if(!title||!link)continue;
        let url;try{url=new URL(link,feed.url).toString()}catch{continue}
        if(!hostAllowed(url))continue;
        const stamp=Date.parse(date),published=Number.isFinite(stamp)?new Date(stamp).toISOString():null;
        for(const instrument of list) {
          const ticker=String(instrument.symbol).toUpperCase();
          if(!cleanNseFeedItemMatches(title+' '+description,ticker,instrument.name))continue;
          try {
            await saveItem({runId,ticker,sourceType:feed.source_type,title,url,published,excerpt:description,feed,db});
            const result=results.get(ticker);result.status='stored_unverified';result.stored++;
            batch.stored++;
          } catch(error) {
            const result=results.get(ticker);result.status='feed_error';result.errors.push(String(error?.message||error).slice(0,160));
            batch.errors.push({ticker,feed:feed.label,error:String(error?.message||error).slice(0,160)});
          }
        }
      }
    } catch(error) {
      batch.errors.push({feed:feed.label,error:String(error?.message||error).slice(0,160)});
      for(const result of results.values())if(result.status==='no_matching_items')result.status='feed_error';
    }
  }
  batch.results=[...results.values()];
  batch.status=batch.stored?(batch.errors.length?'partial':'ok'):batch.errors.length?'unavailable':'no_results';
  return batch;
}

export async function collectNseNews({ticker,name,runId=null,db}={}) {
  const batch=await collectNseNewsBatch({instruments:[{symbol:ticker,name}],runId,db});
  return {...batch,results:undefined,...(batch.results[0]||{ticker,status:'unavailable',stored:0,errors:[]})};
}
