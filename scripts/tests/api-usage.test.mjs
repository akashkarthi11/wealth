// API usage page (admin): what each provider allows, what today used, and what is left. A limit is shown only where the
// provider publishes one and this app enforces it — never a guessed number (owner's request, 2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migratedDb } from './helpers/pglite.mjs';

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SRC = read('api/_routes/api-usage.js');
const IST = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";

test('every query the page runs is valid against the real schema', async () => {
  const { a } = await migratedDb();
  const queries = [...SRC.matchAll(/sql\.query\(`([\s\S]*?)`/g)].map(m => m[1]).filter(q => /FROM wealth_/.test(q));
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
  // Fincrux's five a day is the only hard cap in the code; the pacing of the free model is a rate, not a daily cap.
  const enforced = Number(read('api/_lib/stock-advisor-fincrux.js').match(/MAX_DAILY_REQUESTS = (\d+)/)[1]);
  const shown = Number(SRC.match(/limit: (\d+), limit_window: 'per day \(IST\)'/)[1]);
  assert.equal(shown, enforced, 'the page must show the quota the code actually enforces, not a copy that can drift');
  for (const p of ['tejhq', 'mfapi', 'nse']) {
    const block = SRC.slice(SRC.indexOf("key: '" + p + "'"));
    assert.match(block.slice(0, 200), /limit: null/, p + ' publishes no limit, so none is claimed');
  }
  const app = read('app.js');
  assert.match(app, /no published limit/);
  assert.match(app, /A limit is shown only where the provider publishes one/);
  assert.doesNotMatch(SRC, /\b(INSERT|UPDATE|DELETE)\b\s/i, 'the page only reads');
  assert.match(SRC, /role === 'admin'/);
  assert.match(read('api/router.js'), /'api-usage': \(\) => import/);
  assert.match(read('api/_roles.js'), /ADMIN_ONLY_VIEWS = \[[^\]]*'api-usage'/);
  assert.match(read('index.html'), /data-view="api-usage"[^>]*data-owner-only/);
});
