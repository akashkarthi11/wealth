const BASE='https://api.mfapi.in/mf';
const timeout=ms=>AbortSignal.timeout(ms);
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const normalize=s=>clean(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function getJson(url){
 const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'MyWealthPersonalResearch/1.0'},signal:timeout(9000)});
 if(!response.ok)throw new Error('MFAPI HTTP '+response.status);
 return response.json();
}

export async function resolveMfScheme(input={}){
 const raw=clean(input.schemeCode||input.ticker||input.name);
 if(/^\d{4,8}$/.test(raw))return {schemeCode:raw,schemeName:clean(input.name)||raw,resolvedBy:'saved_scheme_code'};
 if(!raw)throw new Error('Mutual fund scheme name or AMFI scheme code is required.');
 const matches=await getJson(BASE+'/search?q='+encodeURIComponent(raw));
 if(!Array.isArray(matches)||!matches.length)throw new Error('MFAPI returned no matching schemes.');
 const target=normalize(raw);
 const candidates=matches.filter(x=>x?.schemeCode&&x?.schemeName);
 const exact=candidates.find(x=>normalize(x.schemeName)===target);
 const directGrowth=candidates.find(x=>normalize(x.schemeName).includes(target)&&/direct plan/i.test(x.schemeName)&&/growth/i.test(x.schemeName));
 const selected=exact||directGrowth||candidates.find(x=>normalize(x.schemeName).includes(target));
 if(!selected)throw new Error('No sufficiently close MFAPI scheme match; refusing ambiguous resolution.');
 return {schemeCode:String(selected.schemeCode),schemeName:clean(selected.schemeName),resolvedBy:exact?'exact_name':directGrowth?'direct_growth_name':'name_contains'};
}

export async function collectMutualFundEvidence({ticker,name,runId,db,schemeCode,instrumentId}={}){
 const result={provider:'MFAPI.in',ticker:String(ticker||'').toUpperCase(),fetched_at:new Date().toISOString(),status:'unavailable',scheme:null,observations:0,stored:0,error:null};
 try{
  const scheme=await resolveMfScheme({schemeCode,name:name||ticker});
  const payload=await getJson(BASE+'/'+encodeURIComponent(scheme.schemeCode));
  const rows=Array.isArray(payload?.data)?payload.data:[];
  const navRows=rows.map(row=>{
   const nav=Number(row?.nav),parts=String(row?.date||'').split('-');
   const observed=parts.length===3?new Date(Date.UTC(Number(parts[2]),Number(parts[1])-1,Number(parts[0]))):null;
   return {nav,date:observed&&!Number.isNaN(observed.getTime())?observed.toISOString():null};
  }).filter(x=>Number.isFinite(x.nav)&&x.nav>0&&x.date).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,260);
  if(!navRows.length)throw new Error('MFAPI returned no valid dated NAV observations.');
  result.scheme={scheme_code:scheme.schemeCode,scheme_name:clean(payload?.meta?.scheme_name)||scheme.schemeName,fund_house:clean(payload?.meta?.fund_house)||null,scheme_type:clean(payload?.meta?.scheme_type)||null,scheme_category:clean(payload?.meta?.scheme_category)||null,resolved_by:scheme.resolvedBy};
  result.observations=navRows.length;
  const latest=navRows[0];
  const evidence={provider:'MFAPI.in',scheme_code:scheme.schemeCode,scheme_name:result.scheme.scheme_name,fund_house:result.scheme.fund_house,scheme_type:result.scheme.scheme_type,scheme_category:result.scheme.scheme_category,nav_observations:navRows.slice(0,5),history_observations:navRows.length,first_date:navRows[navRows.length-1]?.date||null,last_date:latest.date,currency:'INR',provider_retrieved_at:result.fetched_at,verification_basis:'Valid dated NAV observations returned by MFAPI API; scheme identity resolved by code or name match.'};
  const [instrument] = instrumentId
    ? [{id:instrumentId}]
    : await db.query('SELECT id FROM wealth_instruments WHERE upper(symbol)=upper($1) LIMIT 1',[ticker]);
  if(instrument?.id){
   for(const observation of navRows){
    await db.query(`INSERT INTO wealth_instrument_prices(instrument_id,as_of,source,price,fx_to_inr,fetched_at)
      VALUES($1,$2::timestamptz,'MFAPI.in',$3,1,$4::timestamptz)
      ON CONFLICT(instrument_id,as_of,source) DO UPDATE SET price=EXCLUDED.price,fx_to_inr=EXCLUDED.fx_to_inr,fetched_at=EXCLUDED.fetched_at`,
      [instrument.id,observation.date,observation.nav,result.fetched_at]);
   }
  }
  const sourceUrl='https://api.mfapi.in/mf/'+scheme.schemeCode;
  let saved;
  if(runId){
   saved=await db.query("INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status) VALUES ($1,$2,'fund_nav',$3,$4,'MFAPI.in',$5::timestamptz,$6::timestamptz,$7,$8::jsonb,'verified') ON CONFLICT (run_id,ticker,url) DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=EXCLUDED.retrieved_at,excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified' RETURNING id",
    [runId,ticker,'Mutual fund NAV — '+result.scheme.scheme_name,sourceUrl,latest.date,result.fetched_at,'Latest NAV ₹'+latest.nav+' as of '+latest.date+'; '+navRows.length+' historical observations included.',JSON.stringify(evidence)]);
  }else{
   saved=await db.query("INSERT INTO wealth_stock_advisor_research_sources (run_id,ticker,source_type,title,url,publisher,published_at,retrieved_at,excerpt,evidence,verification_status) VALUES (NULL,$1,'fund_nav',$2,$3,'MFAPI.in',$4::timestamptz,$5::timestamptz,$6,$7::jsonb,'verified') ON CONFLICT (ticker,url) WHERE run_id IS NULL DO UPDATE SET title=EXCLUDED.title,published_at=EXCLUDED.published_at,retrieved_at=EXCLUDED.retrieved_at,excerpt=EXCLUDED.excerpt,evidence=EXCLUDED.evidence,verification_status='verified' RETURNING id",
    [ticker,'Mutual fund NAV — '+result.scheme.scheme_name,sourceUrl,latest.date,result.fetched_at,'Latest NAV ₹'+latest.nav+' as of '+latest.date+'; '+navRows.length+' historical observations included.',JSON.stringify(evidence)]);
  }
  result.stored=saved.length?1:0;
  result.price_rows=instrument?.id?navRows.length:0;
  result.status='ok';
 }catch(error){result.error=String(error?.message||error).slice(0,240)}
 return result;
}
