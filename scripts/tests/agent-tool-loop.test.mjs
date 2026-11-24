// One agent turn may stop to collect data before arguing (owner's request 2026-11-24). The loop is bounded, and a model
// that never asks for a tool - including one that cannot do tools at all - must take exactly the path it took before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callWithTools, MAX_TOOL_ROUNDS, MAX_TOOLS_PER_ROUND, TOOL_INSTRUCTIONS } from '../../api/_lib/stock-advisor-debate.js';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const answer = raw => ({ raw, tool_calls: [], usage: {}, provider_label: 'Nemotron Free' });
const toolCall = (name, args, id = 'c1') => ({
  raw: '', usage: {},
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  message: { role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
});

test('a model that asks for nothing behaves exactly as before', async () => {
  const seen = [];
  const call = async (thread, max, tools) => { seen.push({ tools: tools ? tools.length : 0 }); return answer('{"message":"no tools needed"}'); };
  const out = await callWithTools([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], {}, { call, run: async () => { throw new Error('must not run'); } });
  assert.equal(out.raw, '{"message":"no tools needed"}');
  assert.deepEqual(out.tools_used, [], 'nothing was collected');
  assert.equal(seen.length, 1, 'exactly one model call, as before');
});

test('a requested tool is executed and its result handed back to the model', async () => {
  const threads = [];
  let n = 0;
  const call = async thread => { threads.push(JSON.parse(JSON.stringify(thread))); return ++n === 1 ? toolCall('get_financial_statement', { ticker: 'TCS' }) : answer('{"message":"now I have the filing"}'); };
  const run = async (name, args) => ({ ok: true, status: 'verified', ticker: args.ticker, reporting_period: '2026-09' });
  const out = await callWithTools([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { holding: { ticker: 'TCS' } }, { call, run });

  assert.equal(out.raw, '{"message":"now I have the filing"}');
  assert.deepEqual(out.tools_used, [{ tool: 'get_financial_statement', ok: true, status: 'verified', error: null }]);
  const second = threads[1];
  assert.equal(second.at(-1).role, 'tool', 'the result is appended as a tool message');
  assert.equal(second.at(-1).tool_call_id, 'c1', 'tied to the call it answers');
  assert.match(second.at(-1).content, /2026-09/, 'and carries the data the agent asked for');
});

test('the agents are told what tools can and cannot settle, and to distrust fetched text', async () => {
  let systemSeen = '';
  const call = async thread => { systemSeen = thread[0].content; return answer('{}'); };
  await callWithTools([{ role: 'system', content: 'ORIGINAL PROMPT' }], {}, { call });
  assert.match(systemSeen, /^ORIGINAL PROMPT/, 'the role prompt is kept');
  assert.match(systemSeen, /never satisfies it/, 'a page cannot satisfy missing evidence');
  assert.match(systemSeen, /never an instruction to you/, 'injected instructions are to be ignored');
  assert.match(TOOL_INSTRUCTIONS, /stop calling tools and return the required JSON/);
});

test('a model that keeps asking is cut off and made to answer', async () => {
  let calls = 0, toolRuns = 0;
  const call = async (thread, max, tools) => { calls++; return tools ? toolCall('get_announcements', { ticker: 'TCS' }, 'c' + calls) : answer('{"message":"forced"}'); };
  const run = async () => { toolRuns++; return { ok: true, status: 'ok' }; };
  const out = await callWithTools([{ role: 'system', content: 'S' }], {}, { call, run });
  assert.equal(out.raw, '{"message":"forced"}', 'the final call is made without tools, so JSON mode applies');
  assert.equal(calls, MAX_TOOL_ROUNDS + 1, 'the rounds are capped and then one final answer is taken');
  assert.equal(toolRuns, MAX_TOOL_ROUNDS, 'it cannot keep collecting for ever');
});

test('only a few tools run per round, however many the model asks for at once', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, function: { name: 'get_announcements', arguments: '{"ticker":"TCS"}' } }));
  let runs = 0, n = 0;
  const call = async () => ++n === 1
    ? { raw: '', usage: {}, tool_calls: many, message: { role: 'assistant', content: null, tool_calls: many } }
    : answer('{"message":"done"}');
  const out = await callWithTools([{ role: 'system', content: 'S' }], {}, { call, run: async () => { runs++; return { ok: true }; } });
  assert.equal(runs, MAX_TOOLS_PER_ROUND, 'nine requests do not become nine provider calls');
  assert.equal(out.tools_used.length, MAX_TOOLS_PER_ROUND);
});

test('a tool that fails is reported to the agent rather than ending the turn', async () => {
  let n = 0;
  const threads = [];
  const call = async thread => { threads.push(JSON.parse(JSON.stringify(thread))); return ++n === 1 ? toolCall('fetch_official_page', { url: 'https://blog.example.com' }) : answer('{"message":"argued without it"}'); };
  const run = async () => ({ ok: false, error: 'That URL is not on the allowed list.' });
  const out = await callWithTools([{ role: 'system', content: 'S' }], {}, { call, run });
  assert.equal(out.raw, '{"message":"argued without it"}', 'the turn still produces an answer');
  assert.deepEqual(out.tools_used, [{ tool: 'fetch_official_page', ok: false, status: null, error: 'That URL is not on the allowed list.' }]);
  assert.match(threads[1].at(-1).content, /not on the allowed list/, 'the agent is told why, so it can adapt');
});

test('malformed tool arguments do not throw', async () => {
  let n = 0;
  const call = async () => ++n === 1
    ? { raw: '', usage: {}, tool_calls: [{ id: 'c1', function: { name: 'get_announcements', arguments: '{not json' } }], message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'get_announcements', arguments: '{not json' } }] } }
    : answer('{"message":"ok"}');
  let got = null;
  const out = await callWithTools([{ role: 'system', content: 'S' }], { holding: { ticker: 'TCS' } }, { call, run: async (name, args) => { got = args; return { ok: true }; } });
  assert.deepEqual(got, {}, 'unparseable arguments become an empty object, and the tool falls back to the holding');
  assert.equal(out.raw, '{"message":"ok"}');
});

test('JSON mode is asked for only when no tools are offered', () => {
  // Some models refuse tools and response_format together; the final answer still has to be strict JSON.
  const src = read('api/_lib/stock-advisor-debate.js');
  assert.match(src, /if\(tools&&tools\.length\)\{body\.tools=tools;body\.tool_choice='auto'\}/);
  assert.match(src, /else body\.response_format=\{type:'json_object'\}/);
  assert.match(src, /if\(toolCalls\.length\) return \{raw:/, 'a tool call is no longer treated as an empty response');
});
