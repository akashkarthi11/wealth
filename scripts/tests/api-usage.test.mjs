// API usage page (admin): what each provider allows, what today used, and what is left. A limit is shown only where the
// provider publishes one and this app enforces it — never a guessed number (owner's request, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SRC = read('api/_routes/api-usage.js');
// The provider list itself — quotas, usage, health — lives in provider-directory.js, shared with Provider Health, so
// both pages read the same queries rather than two copies that can drift (2026-11-24).
const DIR = read('api/_lib/provider-directory.js');
const IST = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";

test('every query the page runs is valid against the real schema', async () => {
  const { a } = await migratedDb();
  const queries = [...(SRC + DIR).matchAll(/sql\.query\(`([\s\S]*?)`/g)].map(m => m[1]).filter(q => /FROM wealth_/.test(q));
  assert.ok(queries.length >= 3, 'the page reads provider activity, the Fincrux quota and the model calls');
  for (const q of queries) {
    const text = q.split('${IST_DAY}').join(IST);
    // The AI pacing table is created lazily by the first debate; the route catches that, so a missing table is fine here.
    try { await a.query(text, []); }
    catch (e) { assert.match(String(e.message), /wealth_stock_advisor_ai_rate_limit/, 'only the lazily created table may be missing'); }
  }
});

test('the Fincrux quota is counted for the Indian day and runs out at five', async () => {
  const { a } = await migratedDb();
  const add = (ticker, when) => a.query(`INSERT INTO wealth_stock_advisor_research_sources
    (run_id,ticker,source_type,title,url,publisher,retrieved_at,evidence,verification_status)
    VALUES (NULL,$1,'financial_statement','t','https://x.test/'||$1,'Fincrux',${when},'{}'::jsonb,'unverified')`, [ticker]);
  const used = async () => Number((await a.query(`SELECT count(*)::int AS used FROM wealth_stock_advisor_research_sources
    WHERE publisher='Fincrux' AND retrieved_at >= ${IST} AND retrieved_at < (${IST} + interval '1 day')`))[0].used);

  assert.equal(await used(), 0);
  for (const t of ['A', 'B', 'C']) await add(t, 'now()');
  await add('OLD', `${IST} - interval '2 hours'`);   // yesterday IST, must not count
  assert.equal(await used(), 3, 'only what was fetched today, Indian time');
  assert.equal(Math.max(0, 5 - await used()), 2, 'two of the five left');
});

test('a manual Fincrux call counts against the account that paid for it', async () => {
  // The reservation url carries the account as '#key-<id>', and a manual call appends '-manual-<uuid>'. That suffix
  // made the per-account row a different key, so the account still read 0 of 5 used while the provider total said 2 —
  // the owner would have believed there was quota left that was already spent (found 2026-11-24).
  const { a } = await migratedDb();
  const query = [...DIR.matchAll(/sql\.query\(`([\s\S]*?)`\)/g)].map(m => m[1]).find(q => /AS key_id/.test(q));
  assert.ok(query, 'the page reads usage per account');
  const add = (ticker, suffix) => a.query(`INSERT INTO wealth_stock_advisor_research_sources
    (run_id,ticker,source_type,title,url,publisher,retrieved_at,evidence,verification_status)
    VALUES (NULL,$1,'financial_statement','t','https://x.test/'||$1||'#key-'||$2,'Fincrux',now(),'{}'::jsonb,'unverified')`,
    [ticker, suffix]);
  await add('AUTO', '7');                                           // the scheduled run
  await add('MANUAL', '7-manual-3f1b9c2e-0000-4000-8000-000000000001');  // the owner pressing the button
  await add('OTHER', '8');                                          // a second account, untouched by either

  const rows = await a.query(query.split('${IST_DAY}').join(IST), []);
  const used = new Map(rows.map(r => [String(r.key_id), Number(r.used)]));
  assert.equal(used.get('7'), 2, 'both calls belong to account 7, manual or not');
  assert.equal(used.get('8'), 1, 'and the other account keeps its own count');
  assert.equal(Math.max(0, 5 - used.get('7')), 3, 'three of the five left, not four');
});

test('model calls are counted, and an answer given without the model is counted apart from them', async () => {
  const { a } = await migratedDb();
  const [user] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('u@x.test','x','admin') RETURNING id`);
  const [run] = await a.query(`INSERT INTO wealth_stock_advisor_runs(user_id,run_key,status) VALUES($1,'k','completed') RETURNING id`, [user.id]);
  const msg = (seq, meta) => a.query(`INSERT INTO wealth_stock_advisor_messages(run_id,sequence_no,speaker,message_type,content,metadata)
    VALUES($1,$2,'s','analysis','{}'::jsonb,$3::jsonb)`, [run.id, seq, JSON.stringify(meta)]);
  await msg(0, { model: 'nemotron', usage: { prompt_tokens: 1200, completion_tokens: 300 } });
  await msg(1, { model: 'nemotron', usage: { prompt_tokens: 800, completion_tokens: 200 } });
  await msg(8, { no_model: true, usage: { prompt_tokens: 0, completion_tokens: 0 } });
  const [row] = await a.query(`SELECT
      count(*) FILTER (WHERE COALESCE(metadata->>'no_model','') <> 'true')::int AS calls,
      count(*) FILTER (WHERE metadata->>'no_model' = 'true')::int AS without_model,
      sum(CASE WHEN metadata->'usage'->>'prompt_tokens' ~ '^[0-9]+$' THEN (metadata->'usage'->>'prompt_tokens')::int ELSE 0 END)::int AS prompt_tokens
    FROM wealth_stock_advisor_messages WHERE created_at >= ${IST}`);
  assert.deepEqual([row.calls, row.without_model, row.prompt_tokens], [2, 1, 2000]);
});

test('the page states a limit only where one is published, and never invents one', () => {
  // Fincrux's allowance is five a day PER KEY, so the page multiplies it by the number of active accounts. That
  // per-key figure must stay the one the adapter enforces, not a copy that can drift.
  const enforced = Number(read('api/_lib/stock-advisor-fincrux.js').match(/MAX_DAILY_REQUESTS = (\d+)/)[1]);
  const shown = Number(DIR.match(/const fincruxLimit = (\d+) \* activeFincruxAccounts\.length/)[1]);
  assert.equal(shown, enforced, 'the per-key quota on the page is the one the adapter enforces');
  assert.match(DIR, /limit_window: 'per day \(IST; 5 per account\)'/, 'and the window says it is per account');
  for (const p of ['tejhq', 'mfapi', 'nse']) {
    const block = DIR.slice(DIR.indexOf("key: '" + p + "'"));
    assert.match(block.slice(0, 200), /limit: null/, p + ' publishes no limit, so none is claimed');
  }
  const app = read('app.js');
  assert.match(app, /no published limit/);
  // The wording may change; what must survive is that a missing quota is not read as "unlimited".
  assert.match(app, /does not mean unlimited/i, 'the page says a missing limit is not permission to call freely');
  assert.doesNotMatch(SRC, /\b(INSERT|UPDATE|DELETE)\b\s/i, 'the page only reads');
  assert.doesNotMatch(DIR, /\b(INSERT|UPDATE|DELETE)\b\s/i, 'the shared directory only reads too');
  assert.match(SRC, /role === 'admin'/);
  assert.match(read('api/router.js'), /'api-usage': \(\) => import/);
  assert.match(read('api/_roles.js'), /ADMIN_ONLY_VIEWS = \[[^\]]*'api-usage'/);
  assert.match(read('index.html'), /data-view="api-usage"[^>]*data-owner-only/);
});

test('Provider Health and API usage read the exact same provider list, so they cannot drift', () => {
  // Provider Health had its own hardcoded six-provider array in stock-advisor.js, built from env checks only. It did
  // not know Agent web or Web search existed, and never showed real usage numbers the way API usage already did -
  // the two pages disagreed about what providers even exist (owner's request 2026-11-24).
  const advisor = read('api/_routes/stock-advisor.js');
  assert.match(SRC, /buildProviderDirectory\(sql\)/, 'API usage reads the shared directory');
  assert.match(advisor, /buildProviderDirectory\(sql\)/, 'Provider Health reads the same shared directory');
  assert.doesNotMatch(advisor, /key:'tejhq'|key:'nemotron'/, 'the old hardcoded provider array is gone, not left dead alongside the real one');
  // The full directory, not a trimmed one: agent tooling that API usage already tracks must reach Provider Health too.
  for (const key of ['agent-web', 'web-search', 'fincrux', 'free-model', 'tejhq', 'mfapi', 'nse', 'yahoo', 'fx', 'groq', 'period-match'])
    assert.ok(DIR.includes("key: '" + key + "'"), key + ' is in the one shared list');
});
