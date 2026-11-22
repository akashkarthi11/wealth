import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMfScheme, collectMutualFundEvidence } from '../../api/_lib/stock-advisor-mfapi.js';

test('MFAPI resolver accepts an explicit numeric scheme code without a search',async()=>{
 const result=await resolveMfScheme({schemeCode:'119551',name:'Example Fund'});
 assert.deepEqual(result,{schemeCode:'119551',schemeName:'Example Fund',resolvedBy:'saved_scheme_code'});
});
test('MFAPI resolver refuses empty or ambiguous inputs before fetching',async()=>{
 await assert.rejects(()=>resolveMfScheme({}),/scheme name or AMFI scheme code/);
});

test('MFAPI collector stores dated NAV history as one provider evidence record',async()=>{
 const originalFetch=globalThis.fetch;
 const calls=[];
 globalThis.fetch=async url=>({ok:true,status:200,json:async()=>({meta:{scheme_name:'Example Direct Growth',fund_house:'Example AMC',scheme_type:'Open Ended',scheme_category:'Equity'},data:[{date:'22-11-2026',nav:'125.50'},{date:'21-11-2026',nav:'124.75'}]})});
 const db={query:async(sql,params)=>{calls.push({sql,params});return [{id:'source-1'}]}};
 try{
  const result=await collectMutualFundEvidence({ticker:'MF119551',name:'119551',schemeCode:'119551',runId:'run-1',db});
  assert.equal(result.status,'ok');
  assert.equal(result.observations,2);
  assert.equal(result.stored,1);
  assert.equal(calls.length,1);
  const evidence=JSON.parse(calls[0].params[7]);
  assert.equal(evidence.nav_observations.length,2);
  assert.equal(evidence.nav_observations[0].nav,125.5);
 }finally{globalThis.fetch=originalFetch}
});
