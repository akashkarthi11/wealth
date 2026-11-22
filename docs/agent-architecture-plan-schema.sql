-- Development-only planning registry for the My Wealth multi-agent architecture study.
-- This is deliberately NOT in scripts/migrations: that directory is applied to Production builds.
-- Apply only to Neon project wealth-development / branch development.
CREATE TABLE IF NOT EXISTS public.wealth_agent_architecture_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL UNIQUE,
  title text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','in_progress','completed','paused')),
  scope text NOT NULL,
  total_estimated_minutes integer NOT NULL CHECK (total_estimated_minutes > 0),
  architecture jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(architecture)='object'),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(constraints)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wealth_agent_architecture_plan_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.wealth_agent_architecture_plans(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  phase_no integer NOT NULL CHECK (phase_no BETWEEN 1 AND 15),
  phase_title text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  estimated_minutes integer NOT NULL CHECK (estimated_minutes > 0),
  start_offset_minutes integer NOT NULL CHECK (start_offset_minutes >= 0),
  end_offset_minutes integer NOT NULL CHECK (end_offset_minutes > start_offset_minutes),
  priority text NOT NULL DEFAULT 'high' CHECK (priority IN ('critical','high','medium','low')),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','blocked','completed','deferred')),
  dependencies text[] NOT NULL DEFAULT '{}',
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(acceptance_criteria)='array'),
  implementation_notes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(implementation_notes)='object'),
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_agent_architecture_plan_task_unique UNIQUE(plan_id,task_key),
  CONSTRAINT wealth_agent_architecture_plan_task_duration_check
    CHECK (end_offset_minutes - start_offset_minutes = estimated_minutes)
);

CREATE INDEX IF NOT EXISTS wealth_agent_architecture_tasks_plan_order_idx
  ON public.wealth_agent_architecture_plan_tasks(plan_id,sort_order);
CREATE INDEX IF NOT EXISTS wealth_agent_architecture_tasks_status_idx
  ON public.wealth_agent_architecture_plan_tasks(plan_id,status);

INSERT INTO public.wealth_agent_architecture_plans
  (plan_key,title,version,status,scope,total_estimated_minutes,architecture,constraints)
VALUES
  ('my-wealth-multi-agent-v1',
   'My Wealth Multi-Agent Financial Intelligence Architecture',
   1,'draft',
   'Development-only architecture plan: preserve the existing Bull/Bear/CIO committee and add deterministic specialist modules, verification, orchestration and observability for Indian equities and ETFs.',
   480,
   '{"decision_personas":["bull","bear","cio"],"specialist_modules":["evidence_quality","fundamental","technical","valuation","portfolio_risk","news_catalyst"],"control_modules":["orchestrator","independent_decision_verifier"],"future_modules":["outcome_evaluator"],"existing_debate_steps":9,"coordination":"centralized orchestrator with bounded parallel specialist fan-out and shared immutable evidence"}'::jsonb,
   '["Development branch and Development Neon database only","₹0 incremental AI API budget target","Indian-listed equities and ETFs only","No F&O or non-Indian market recommendations","No trade execution or broker write permissions","Preserve Bull/Bear four-round debate and CIO final decision","Reuse existing market-price, history, evidence, run, message, agent-output, queue and scheduler tables","Do not add duplicate price, evidence or scheduler tables","MTF is unknown unless current verified broker evidence exists","Missing or stale critical evidence must block BUY","Production remains untouched"]'::jsonb)
ON CONFLICT (plan_key) DO NOTHING;

INSERT INTO public.wealth_agent_architecture_plan_tasks
  (plan_id,task_key,phase_no,phase_title,title,description,estimated_minutes,start_offset_minutes,end_offset_minutes,priority,dependencies,acceptance_criteria,sort_order)
SELECT p.id,x.task_key,x.phase_no,x.phase_title,x.title,x.description,x.estimated_minutes,
       x.start_offset_minutes,x.end_offset_minutes,x.priority,x.dependencies,
       x.acceptance_criteria,x.sort_order
FROM public.wealth_agent_architecture_plans p
CROSS JOIN jsonb_to_recordset(
'[
 {"task_key":"audit","phase_no":1,"phase_title":"Audit & contracts","title":"Audit current code and run state","description":"Map API routes, scheduler, debate steps, evidence collectors, existing database tables and environment boundaries. Confirm which functions can be reused and identify the Development transcript/evidence persistence gap.","estimated_minutes":40,"start_offset_minutes":0,"end_offset_minutes":40,"priority":"critical","dependencies":[],"acceptance_criteria":["Document current 3 decision personas and 9 LLM steps","Map existing collectors and scheduler handlers","Confirm no duplicate price/history/source/scheduler tables are needed","Record Development-only baseline and production boundary"],"sort_order":1},
 {"task_key":"contracts","phase_no":2,"phase_title":"Audit & contracts","title":"Freeze shared evidence and specialist contracts","description":"Define one immutable evidence snapshot and typed specialist JSON output. Every numeric result carries unit, as-of time, source ID, verification status and missing-data reason; distinguish facts, calculations, assumptions and opinions.","estimated_minutes":30,"start_offset_minutes":40,"end_offset_minutes":70,"priority":"critical","dependencies":["audit"],"acceptance_criteria":["Versioned evidence-package contract exists","Specialist output schema is validated","No unsupported field is silently defaulted to zero","All specialist claims link to existing evidence IDs"],"sort_order":2},
 {"task_key":"orchestrator","phase_no":3,"phase_title":"Orchestration","title":"Add orchestrator stage graph","description":"Extend existing per-run stage queue with dependency ordering, stage state, idempotency keys, leases, bounded fan-out and resumability. Keep existing central scheduler; do not create a cron per specialist.","estimated_minutes":35,"start_offset_minutes":70,"end_offset_minutes":105,"priority":"critical","dependencies":["contracts"],"acceptance_criteria":["Stages can resume after timeout","Repeated dispatch does not duplicate a stage","Parallelism is bounded and configurable","Existing 60-second function limits are respected"],"sort_order":3},
 {"task_key":"evidence-quality","phase_no":4,"phase_title":"Evidence & specialists","title":"Evidence freshness and deduplication","description":"Add per-source freshness rules, stable evidence references, canonical URL/ticker deduplication and required-category coverage using existing research-source and price tables.","estimated_minutes":35,"start_offset_minutes":105,"end_offset_minutes":140,"priority":"critical","dependencies":["contracts","orchestrator"],"acceptance_criteria":["Fresh verified DB evidence is reused before provider calls","Stale evidence is visibly marked","Unverified sources cannot unlock BUY","Duplicate URLs/facts do not create duplicate evidence rows"],"sort_order":4},
 {"task_key":"technical","phase_no":5,"phase_title":"Evidence & specialists","title":"Technical specialist","description":"Wrap existing TejHQ NSE EOD OHLCV and indicator calculations in a typed specialist result. Include SMA20/50/200, RSI14, MACD, volume and data limitations only where observations support them.","estimated_minutes":25,"start_offset_minutes":140,"end_offset_minutes":165,"priority":"high","dependencies":["evidence-quality"],"acceptance_criteria":["Technical output references TejHQ evidence IDs","Insufficient history returns missing fields, not invented values","EOD/delayed status is explicit","No intraday/live quote claims"],"sort_order":5},
 {"task_key":"fundamental","phase_no":6,"phase_title":"Evidence & specialists","title":"Fundamental specialist","description":"Normalize verified financial statement evidence from existing source records and optional configured Fincrux data. Compute growth, margin, leverage and cash-flow trends only from actual source fields.","estimated_minutes":30,"start_offset_minutes":165,"end_offset_minutes":195,"priority":"high","dependencies":["evidence-quality"],"acceptance_criteria":["Each ratio includes formula and source fields","Missing statements remain null with a reason","Unverified Fincrux content is not promoted to verified","No fabricated ROE, debt, EPS or cash-flow values"],"sort_order":6},
 {"task_key":"valuation","phase_no":7,"phase_title":"Evidence & specialists","title":"Valuation specialist","description":"Calculate supported valuation multiples and scenario ranges from validated price, earnings, cash-flow and share-count inputs. If essential data is absent, return DATA REQUIRED for valuation.","estimated_minutes":25,"start_offset_minutes":195,"end_offset_minutes":220,"priority":"high","dependencies":["fundamental","technical"],"acceptance_criteria":["Every valuation output records formula and input dates","No unsupported fair value or target price is generated","Scenarios expose assumptions separately from facts","Missing inputs produce an explicit limitation"],"sort_order":7},
 {"task_key":"portfolio-risk","phase_no":8,"phase_title":"Evidence & specialists","title":"Portfolio and MTF risk specialist","description":"Use existing Indian positions to calculate sector weights, single-stock concentration, small-cap exposure, overlap and risk context. MTF is included only from current verified broker evidence.","estimated_minutes":35,"start_offset_minutes":220,"end_offset_minutes":255,"priority":"critical","dependencies":["contracts","evidence-quality"],"acceptance_criteria":["Portfolio scope is Indian equities/ETFs only","Sector and concentration calculations are reproducible","MTF is UNKNOWN without verified current broker data","No trading or broker write action is exposed"],"sort_order":8},
 {"task_key":"catalysts","phase_no":9,"phase_title":"Evidence & specialists","title":"News and catalyst specialist","description":"Classify existing NSE RSS and announcement evidence into results, orders, management, corporate actions and material risks. Preserve original source URL and publication time.","estimated_minutes":20,"start_offset_minutes":255,"end_offset_minutes":275,"priority":"medium","dependencies":["evidence-quality"],"acceptance_criteria":["Every catalyst links to source URL and publisher","Publication time and retrieval time are distinct","Duplicate announcements are suppressed","Stale or unverified items are labelled"],"sort_order":9},
 {"task_key":"verifier","phase_no":10,"phase_title":"Decision governance","title":"Independent decision verifier","description":"Validate specialist outputs and final CIO JSON against schemas, source IDs, freshness, action gate, unsupported numbers, portfolio rules and contradictions. Downgrade unsafe output to DATA REQUIRED.","estimated_minutes":30,"start_offset_minutes":275,"end_offset_minutes":305,"priority":"critical","dependencies":["technical","fundamental","valuation","portfolio-risk","catalysts"],"acceptance_criteria":["Invalid evidence references are rejected","Unsupported numeric claims are flagged","BUY is impossible when evidence gate is not ready","Verifier output includes reasons and failing checks"],"sort_order":10},
 {"task_key":"committee","phase_no":11,"phase_title":"Committee integration","title":"Integrate with existing Bull/Bear/CIO debate","description":"Pass specialist summaries and identical source references to the current four-round debate. Keep the existing 8 Bull/Bear steps plus CIO final step and current free-model pacing.","estimated_minutes":40,"start_offset_minutes":305,"end_offset_minutes":345,"priority":"critical","dependencies":["verifier"],"acceptance_criteria":["Bull and Bear receive the same evidence package","Four debate rounds remain intact","CIO adjudicates the full debate","Current decision contract remains BUY/HOLD/SELL/DATA REQUIRED"],"sort_order":11},
 {"task_key":"persistence","phase_no":12,"phase_title":"Persistence & cost controls","title":"Persist specialist outputs in existing tables","description":"Store each typed specialist output in wealth_stock_advisor_agent_outputs and link it to run/ticker/stage. Use existing messages, reports and research-source tables; preserve idempotency and historical records.","estimated_minutes":25,"start_offset_minutes":345,"end_offset_minutes":370,"priority":"critical","dependencies":["committee"],"acceptance_criteria":["Specialist output rows link to the correct run and ticker","Retries do not duplicate output rows","Transcript and report remain readable","No duplicate evidence or price table is introduced"],"sort_order":12},
 {"task_key":"provider-budget","phase_no":13,"phase_title":"Persistence & cost controls","title":"Queue, rate limits and fallback behaviour","description":"Respect shared NVIDIA free-tier pacing, existing queue/retry system and per-run concurrency. No paid provider dependency; no silent model switch. A free fallback is allowed only after a real adapter and terms/rate-limit checks exist.","estimated_minutes":30,"start_offset_minutes":370,"end_offset_minutes":400,"priority":"high","dependencies":["orchestrator","persistence"],"acceptance_criteria":["Free model pacing is shared across runs","429 and timeout responses retry safely","No paid provider is called","Unconfigured fallback is reported as unavailable, not assumed"],"sort_order":13},
 {"task_key":"tests","phase_no":14,"phase_title":"Quality & release checks","title":"Automated tests and failure injection","description":"Test good evidence, missing/stale inputs, duplicate sources, provider 429, timeout, malformed JSON, conflicting specialist results and resumed jobs.","estimated_minutes":45,"start_offset_minutes":400,"end_offset_minutes":445,"priority":"critical","dependencies":["provider-budget","verifier"],"acceptance_criteria":["BUY blocked for missing critical evidence","No duplicate messages or outputs after retry","All specialist schemas pass/fail predictably","Portfolio and MTF guardrails are tested","Regression suite passes"],"sort_order":14},
 {"task_key":"ui-preview","phase_no":15,"phase_title":"Quality & release checks","title":"UI, documentation and Development preview","description":"Show stage timeline, specialist status, source citations, missing-data reasons, verifier findings and final CIO result. Run tests and preview-only checks; do not merge to main or touch Production.","estimated_minutes":35,"start_offset_minutes":445,"end_offset_minutes":480,"priority":"high","dependencies":["tests"],"acceptance_criteria":["Mobile-friendly agent execution timeline is visible","Failures and skipped stages have clear reasons","Development preview is verified","Production branch and database remain unchanged"],"sort_order":15}
]'::jsonb) AS x(
 task_key text,phase_no integer,phase_title text,title text,description text,
 estimated_minutes integer,start_offset_minutes integer,end_offset_minutes integer,
 priority text,dependencies text[],acceptance_criteria jsonb,sort_order integer
)
WHERE p.plan_key='my-wealth-multi-agent-v1'
ON CONFLICT (plan_id,task_key) DO NOTHING;
