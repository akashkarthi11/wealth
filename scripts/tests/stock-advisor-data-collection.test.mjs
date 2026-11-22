import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNseFeedItemMatches } from '../../api/_lib/stock-advisor-data-collection.js';

test('NSE matching requires a symbol token or meaningful company-name match',()=>{
 assert.equal(cleanNseFeedItemMatches('ABC Ltd board meeting','ABC','ABC Limited'),true);
 assert.equal(cleanNseFeedItemMatches('ABCDEF announces results','ABC','Other Company'),false);
 assert.equal(cleanNseFeedItemMatches('Example Industries quarterly result','EXMPL','Example Industries'),true);
});
