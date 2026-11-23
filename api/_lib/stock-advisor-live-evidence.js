const NSE_HOSTS = new Set(['www.nseindia.com','nsearchives.nseindia.com','nseindia.com']);
export const NSE_FEED_LABELS = ['Announcements','Financial results','Annual reports','Board meetings','Shareholding patterns','Corporate actions'];
const NSE_FEEDS = Object.freeze([
  { label:'Announcements', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml' },
  { label:'Financial results', source_type:'financial_statement', url:'https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml' },
  { label:'Annual reports', source_type:'financial_statement', url:'https://nsearchives.nseindia.com/content/RSS/Annual_Reports.xml' },
  { label:'Board meetings', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml' },
  { label:'Shareholding patterns', source_type:'exchange_filing', url:'https://nsearchives.nseindia.com/content/RSS/Shareholding_Pattern.xml' },
  { label:'Corporate actions', source_type:'corporate_announcement', url:'https://nsearchives.nseindia.com/content/RSS/Corporate_action.xml' }
]);
const timeout = ms => AbortSignal.timeout(ms);
// NSE's own master lists of tradable symbols. Each gives a symbol and the registered name it is announced under, so a
// holding saved as "ONGC" still matches "Oil & Natural Gas Corporation Limited". Names come from NSE, never from this code.
// Adding a list here is all that is needed to cover a new instrument type; a list that cannot be read is reported and skipped.
const NSE_SYMBOL_LISTS = Object.freeze([
  { label: 'Equities', url: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv' },
  { label: 'ETFs', url: 'https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv' },
  { label: 'SME', url: 'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv' },
  { label: 'Debt', url: 'https://nsearchives.nseindia.com/content/equities/DEBT_L.csv' },
]);
const SYMBOL_HEADERS = ['SYMBOL', 'SCRIP CODE', 'SCRIP'];
const NAME_HEADERS = ['NAME OF COMPANY', 'COMPANY NAME', 'SECURITY NAME', 'NAME OF SECURITY', 'ISSUER NAME', 'UNDERLYING', 'NAME'];
const csvCells = line => {
  const out = []; let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  out.push(cell.trim());
  return out;
};
// Reads any NSE master list: the symbol and name columns are found from the header, so each list's own layout is followed.
export function parseNseSymbolList(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  const map = new Map();
  if (!lines.length) return map;
  const header = csvCells(lines[0]).map(h => h.toUpperCase().replace(/[^A-Z]+/g, ' ').trim());
  const iSymbol = header.findIndex(h => SYMBOL_HEADERS.includes(h));
  const iName = NAME_HEADERS.reduce((found, want) => found >= 0 ? found : header.indexOf(want), -1);
  if (iSymbol < 0 || iName < 0) return map;
  for (const line of lines.slice(1)) {
    const cells = csvCells(line);
    const symbol = String(cells[iSymbol] || '').toUpperCase(), name = String(cells[iName] || '').trim();
    if (symbol && name && name.toUpperCase() !== symbol) map.set(symbol, name);
  }
  return map;
}
let symbolNames = { at: 0, map: null, sources: [], errors: [] };
export function resetNseSymbolNames() { symbolNames = { at: 0, map: null, sources: [], errors: [] }; }
// Every list is fetched once per instance and merged. One unreachable list never stops the others, and a run that has
// none of them simply matches on the saved name.
// A failed attempt is remembered too, briefly: without that, every holding in a run would retry every list.
export async function nseSymbolNames({ now = Date.now(), ttlMs = 6 * 3600 * 1000, failTtlMs = 5 * 60 * 1000, cachedOnly = false } = {}) {
  if (symbolNames.at && now - symbolNames.at < (symbolNames.map ? ttlMs : failTtlMs)) return symbolNames;
  if (cachedOnly) return symbolNames;   // no time to download; use whatever is already held
  const map = new Map(), sources = [], errors = [];
  const loaded = await Promise.all(NSE_SYMBOL_LISTS.map(async list => {
    try {
      const response = await fetch(list.url, { headers: { Accept: 'text/csv', 'User-Agent': 'MyWealthPersonalResearch/1.0' }, signal: timeout(10000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const parsed = parseNseSymbolList(await response.text());
      if (!parsed.size) throw new Error('no symbol/name columns found in the file');
      return { list, parsed };
    } catch (error) {
      return { list, error: String(error?.message || error).slice(0, 120) };
    }
  }));
  for (const row of loaded) {
    if (row.error) { errors.push({ list: row.list.label, error: row.error }); continue; }
    // First list to supply a symbol wins, so Equities stays authoritative where lists overlap.
    for (const [symbol, name] of row.parsed) if (!map.has(symbol)) map.set(symbol, name);
    sources.push({ label: row.list.label, symbols: row.parsed.size });
  }
  symbolNames = map.size
    ? { at: now, map, sources, errors }
    : { at: now, map: symbolNames.map, sources, errors };   // keep the previous map rather than losing it
  return symbolNames;
}
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

// Does this announcement TITLE name this holding? Any of the names it may be announced under may be given: the saved
// one and NSE's registered name for the symbol. A real company name is always preferred, because an exchange symbol
// can be an ordinary word or the first word of a different company ("Reliance Power" is not "Reliance Industries").
export function nseFeedItemMatchesAny(text,ticker,names) {
  const raw=String(text||''),value=nseWords(raw),symbol=nseWords(ticker);
  if(!value)return false;
  const all=(Array.isArray(names)?names:[names]).map(nseWords).filter(Boolean);
  // A name that is more than the bare symbol is the trustworthy one; only fall back to symbol-shaped names.
  const named=all.filter(n=>n!==symbol),use=(named.length?named:all).map(nseCore).filter(Boolean);
  if(use.some(c=>value===c||value.startsWith(c+' ')))return true;
  // NSE writes the exchange symbol in capitals when it means the ticker ("RELIANCE Board Meeting"), which a
  // differently-named company ("Reliance Power Limited") does not do.
  const caps=symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');
  return caps.length>1&&new RegExp('(^|[^A-Za-z0-9])'+caps+'([^A-Za-z0-9]|$)').test(raw);
}
// An NSE announcement names its company at the START of the title. Matching a name anywhere in the body is not enough:
// Production stored "Lotus Eye Hospital and Institute Limited" against RELIANCE because its boilerplate said
// "any acquisition made in reliance upon exemption" (owner's run, 2026-11-23). Pass the TITLE, not title+body.
const nseWords = value => String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/s+/g,' ').trim();
// "ABC Limited" and "ABC Ltd" are the same company, so the trailing legal form is not part of the comparison.
const nseCore = value => String(value||'').replace(/(s+(limited|ltd|pvt|private))+$/,'').trim();
export function cleanNseFeedItemMatches(text,ticker,name) { return nseFeedItemMatchesAny(text,ticker,[name]); }

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
    await db.query(`
      INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      VALUES($1,$2,$3,$4,$5,'NSE',$6::timestamptz,now(),$7,$8::jsonb,'unverified')
      ON CONFLICT(run_id,ticker,url) DO UPDATE SET
        title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=now(),
        excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='unverified'
    `,[runId,ticker,sourceType,title.slice(0,500),url,published,excerpt.slice(0,1800),JSON.stringify(evidence)]);
  } else {
    await db.query(`
      INSERT INTO wealth_stock_advisor_research_sources
        (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status)
      VALUES(NULL,$1,$2,$3,$4,'NSE',$5::timestamptz,now(),$6,$7::jsonb,'unverified')
      ON CONFLICT(ticker,url) WHERE run_id IS NULL DO UPDATE SET
        source_type=EXCLUDED.source_type,title=EXCLUDED.title,published_at=EXCLUDED.published_at,
        retrieved_at=now(),excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='unverified'
    `,[ticker,sourceType,title.slice(0,500),url,published,excerpt.slice(0,1800),JSON.stringify(evidence)]);
  }
}

// feedLabels limits the run to those NSE feeds (the job queue runs one feed per item, so no single call has to download all six).
export async function collectNseNewsBatch({instruments=[],runId=null,db,deadlineAt=null,feedLabels=null}={}) {
  const feeds=Array.isArray(feedLabels)&&feedLabels.length?NSE_FEEDS.filter(f=>feedLabels.includes(f.label)):NSE_FEEDS;
  const list=(Array.isArray(instruments)?instruments:[]).filter(x=>x?.symbol);
  const results=new Map(list.map(x=>[String(x.symbol).toUpperCase(),{ticker:String(x.symbol).toUpperCase(),status:'no_matching_items',stored:0,errors:[]} ]));
  const batch={provider:'NSE RSS',fetched_at:new Date().toISOString(),feeds_checked:0,stored:0,items_seen:0,errors:[],feeds:[],results:[]};
  // The registered company name for each symbol, so a holding saved as "ONGC" still matches "Oil & Natural Gas Corporation Limited".
  // Downloading the company lists is pointless when there is no time left to read a feed.
  const timeForAFeed=!deadlineAt||deadlineAt-Date.now()>=11000;
  const official=timeForAFeed?await nseSymbolNames():{map:null,sources:[],errors:[]};
  batch.official_names=official.map?official.map.size:0;
  batch.name_lists=official.sources;
  // A list that will not load is reported on its own: it is not a feed failure, and it must not crowd the feed's own reason out of the note.
  batch.name_list_errors=official.errors;
  let feedErrors=0;
  const namesFor=instrument=>{
    const saved=String(instrument?.name||'');
    const registered=official.map?.get(String(instrument?.symbol||'').toUpperCase())||'';
    return registered&&registered.toLowerCase()!==saved.toLowerCase()?[saved,registered]:[saved];
  };
  for(const feed of feeds) {
    // A feed can wait up to 10 seconds; do not start one that could run past the caller's deadline.
    if(deadlineAt&&deadlineAt-Date.now()<11000){batch.errors.push({feed:feed.label,error:'skipped: time limit reached'});feedErrors++;continue}
    try {
      const xml=await getFeed(feed.url);
      batch.feeds_checked++;
      const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
      // What this feed actually carried. Two real titles are kept so an unmatched feed can be diagnosed without another run.
      const feedSeen={label:feed.label,items:items.length,matched:0,sample:[]};
      batch.feeds.push(feedSeen); batch.items_seen+=items.length;
      for(const item of items) {
        const block=item[1],title=tag(block,'title'),link=tag(block,'link'),description=tag(block,'description'),date=tag(block,'pubDate');
        if(!title||!link)continue;
        if(feedSeen.sample.length<2)feedSeen.sample.push(title.slice(0,110));
        let url;try{url=new URL(link,feed.url).toString()}catch{continue}
        if(!hostAllowed(url))continue;
        const stamp=Date.parse(date),published=Number.isFinite(stamp)?new Date(stamp).toISOString():null;
        for(const instrument of list) {
          const ticker=String(instrument.symbol).toUpperCase();
          if(!nseFeedItemMatchesAny(title,ticker,namesFor(instrument)))continue;   // the title names the company; the body is boilerplate
          try {
            await saveItem({runId,ticker,sourceType:feed.source_type,title,url,published,excerpt:description,feed,db});
            const result=results.get(ticker);result.status='stored_unverified';result.stored++;
            batch.stored++;feedSeen.matched++;
          } catch(error) {
            const result=results.get(ticker);result.status='feed_error';result.errors.push(String(error?.message||error).slice(0,160));feedErrors++;
            batch.errors.push({ticker,feed:feed.label,error:String(error?.message||error).slice(0,160)});
          }
        }
      }
    } catch(error) {
      batch.errors.push({feed:feed.label,error:String(error?.message||error).slice(0,160)});feedErrors++;
      for(const result of results.values())if(result.status==='no_matching_items')result.status='feed_error';
    }
  }
  batch.results=[...results.values()];
  batch.feed_errors=feedErrors;
  batch.status=batch.stored?(feedErrors?'partial':'ok'):feedErrors?'unavailable':'no_results';
  if(batch.status==='no_results')batch.errors.push({feed:'(all)',error:batch.items_seen
    ?'read '+batch.items_seen+' announcements but none named a saved holding'+(batch.official_names?' (NSE lists loaded: '+official.sources.map(s=>s.label+' '+s.symbols).join(', ')+')':' and no NSE symbol list could be loaded')
    :'the feeds returned no announcements at all'});
  return batch;
}

export async function collectNseNews({ticker,name,runId=null,db}={}) {
  const batch=await collectNseNewsBatch({instruments:[{symbol:ticker,name}],runId,db});
  return {...batch,results:undefined,...(batch.results[0]||{ticker,status:'unavailable',stored:0,errors:[]})};
}
