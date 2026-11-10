import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const match = source.match(/function usHoldingInrValue\(position\)\s*\{[\s\S]*?\n\}/);
assert.ok(match, 'app.js must define the shared US holding INR valuation helper');
const context = {};
vm.runInNewContext(match[0] + '; globalThis.value = usHoldingInrValue;', context);
const value = context.value;

test('prefers the market-price INR valuation when present', () => {
  assert.equal(value({ market_value_inr: 123.45, current_value: 9, metadata: { inr_conversion: { current_value_inr: 111 } } }), 123.45);
});

test('falls back to the saved INR conversion when market INR is absent', () => {
  assert.equal(value({ market_value_inr: null, metadata: { inr_conversion: { current_value_inr: 222.5 } } }), 222.5);
});

test('converts USD current value using the available FX rate', () => {
  assert.equal(value({ current_value: 7.95, market_fx_to_inr: 93.93, metadata: {} }), 7.95 * 93.93);
});

test('uses saved FX metadata when market FX is unavailable', () => {
  assert.equal(value({ current_value: 2, metadata: { inr_conversion: { usd_inr_rate: 90 } } }), 180);
});

test('does not invent an INR value when no FX rate exists', () => {
  assert.equal(value({ current_value: 7.95, metadata: {} }), 0);
});
