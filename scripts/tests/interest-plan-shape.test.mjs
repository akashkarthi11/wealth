// Every return from planAccrual must carry the same shape. Two early paths left out dayTotals and creditTotals, so
// runAccrual crashed on [...plan.creditTotals.keys()] for an account with no verified balance, or an FD whose terms
// are incomplete — the nightly interest job would have thrown for that account (found 2026-11-24).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAccrual } from '../../api/_interest.js';

const THROUGH = '2026-11-23';
const monthly = { credit: { months: 1, anchor: '2026-11-01' } };

test('a savings account with no verified balance still returns the full shape', () => {
  const plan = planAccrual({ kind: 'savings', balances: [], rates: [{ annual_rate: 0.055, effective_from: '2026-01-01' }], through: THROUGH, ...monthly });
  assert.equal(plan.status, 'stale_balance');
  assert.ok(plan.dayTotals instanceof Map, 'dayTotals is always a Map');
  assert.ok(plan.creditTotals instanceof Map, 'creditTotals is always a Map');
  assert.deepEqual([...plan.creditTotals.keys()], [], 'empty, not missing — the caller reads keys() unconditionally');
});

test('an FD with incomplete terms still returns the full shape', () => {
  const plan = planAccrual({ kind: 'fd', balances: [], rates: [{ annual_rate: 0.0775, effective_from: '2026-01-01' }], terms: { principal: 1000 }, through: THROUGH });
  assert.equal(plan.status, 'pending_terms');
  assert.ok(plan.dayTotals instanceof Map);
  assert.ok(plan.creditTotals instanceof Map);
});

test('every path reports a status and the two totals, so no caller has to guard', () => {
  const rates = [{ annual_rate: 0.055, effective_from: '2026-01-01' }];
  const plans = [
    planAccrual({ kind: 'savings', balances: [], rates, through: THROUGH, ...monthly }),
    planAccrual({ kind: 'savings', balances: [], rates: [], through: THROUGH, ...monthly }),
    planAccrual({ kind: 'fd', balances: [], rates, terms: null, through: THROUGH }),
    planAccrual({ kind: 'savings', balances: [{ as_of: '2026-11-20T00:00:00Z', balance: 1000, status: 'verified' }], rates, through: THROUGH, ...monthly }),
  ];
  for (const plan of plans) {
    assert.ok(typeof plan.status === 'string' && plan.status, 'a status: ' + JSON.stringify(plan.status));
    assert.ok(plan.dayTotals instanceof Map, plan.status + ' has dayTotals');
    assert.ok(plan.creditTotals instanceof Map, plan.status + ' has creditTotals');
    // what runAccrual actually does with them, on every path
    assert.doesNotThrow(() => [...plan.dayTotals.keys()].filter(d => d <= THROUGH).sort().pop());
    assert.doesNotThrow(() => [...plan.creditTotals.keys()].filter(d => d <= THROUGH).sort().pop());
  }
});
