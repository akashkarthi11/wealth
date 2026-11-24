// Stock Advisor: when critical evidence is missing, the eight Bull/Bear model calls are skipped and one DATA REQUIRED CIO result is saved (owner's rule, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldSkipDebate, dataRequiredResult, gatedDecision, cioReady, DEBATE_SEQUENCE } from '../../api/_lib/stock-advisor-debate.js';

const src = readFileSync(new URL('../../api/_lib/stock-advisor-debate.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const closed = { action_gate: 'DATA_REQUIRED', missing_evidence_types: ['financial_statement', 'technical_indicator'] };
const open = { action_gate: 'EVIDENCE_READY', missing_evidence_types: [] };

test('the debate is skipped only when the evidence gate is closed; the environment switch brings the full debate back', () => {
  assert.equal(shouldSkipDebate(closed, {}), true);
  assert.equal(shouldSkipDebate(open, {}), false);
  assert.equal(shouldSkipDebate(closed, { STOCK_ADVISOR_ALWAYS_DEBATE: 'true' }), false);
  assert.equal(shouldSkipDebate(closed, { STOCK_ADVISOR_ALWAYS_DEBATE: 'no' }), true);
  assert.equal(shouldSkipDebate(null, {}), false, 'no evidence snapshot: never guess');
});

test('the saved result is a clear DATA REQUIRED with what is missing and what to do, within the summary limit, and needs no model', () => {
  const r = dataRequiredResult({ evidence: closed, ticker: 'TCS', name: 'Tata Consultancy Services' });
  assert.equal(r.decision, 'DATA REQUIRED');
  assert.deepEqual(r.missing_evidence, ['financial_statement', 'technical_indicator']);
  assert.match(r.summary, /^Decision: DATA REQUIRED\./);
  assert.ok(r.summary.length <= 900);
  assert.match(r.message, /The debate was not run because critical evidence is missing/);
  assert.match(r.message, /• financial statement: Needs a Fincrux snapshot/);
  assert.match(r.message, /• technical indicator: Needs the stored TejHQ price history/);
  assert.equal(r.change_conditions.length, 2);
  assert.match(dataRequiredResult({ evidence: { missing_evidence_types: ['expense_ratio'] }, ticker: 'X' }).change_conditions[0], /No automatic source exists yet/, 'no invented fix for evidence nothing produces');
  assert.equal(gatedDecision(r.decision, closed.action_gate), 'DATA REQUIRED', 'the same decision the gate would have forced');
});

test('wiring: the check runs on the first step, before any model call and before the CIO guard; the result is saved as the CIO message and completes the run', () => {
  // The turn's model call goes through callWithTools now, so an agent may collect data before arguing (2026-11-24).
  // The gate check must still come first: a run with missing evidence answers without spending a model call at all.
  const skip = src.indexOf('shouldSkipDebate(evidence,process.env)'), cio = src.indexOf("if(step===8 && !cioReady(prior))"), model = src.indexOf('await callWithTools([{role:\'system\'');
  assert.ok(model > 0, 'the turn calls the model through the tool loop');
  assert.ok(skip > 0 && skip < cio && skip < model, 'skip check comes before the CIO guard and the first model call');
  assert.match(src, /if\(step===0 && shouldSkipDebate/);
  assert.match(src, /'cio-evidence-gate'/);
  assert.match(src, /advanceStep\(job\.id, run\.id, 8, plan, message,/);
  assert.equal(DEBATE_SEQUENCE[8].side, 'cio');
  assert.equal(cioReady([]), false, 'the normal CIO guard is unchanged');
});
