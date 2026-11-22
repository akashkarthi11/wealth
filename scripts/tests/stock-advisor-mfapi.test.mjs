import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMfScheme } from '../../api/_lib/stock-advisor-mfapi.js';

test('MFAPI resolver accepts an explicit numeric scheme code without a search',async()=>{
 const result=await resolveMfScheme({schemeCode:'119551',name:'Example Fund'});
 assert.deepEqual(result,{schemeCode:'119551',schemeName:'Example Fund',resolvedBy:'saved_scheme_code'});
});
test('MFAPI resolver refuses empty or ambiguous inputs before fetching',async()=>{
 await assert.rejects(()=>resolveMfScheme({}),/scheme name or AMFI scheme code/);
});
