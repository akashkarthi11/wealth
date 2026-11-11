# Engineering Fix Index

This folder is the permanent engineering knowledge base for the Wealth application.

## Rules for every fix

1. **Search before fixing.** Read this index and the relevant module's existing fix notes before changing code or data.
2. **Reuse prior decisions.** If the same or a closely related issue exists, compare symptoms, root cause, affected modules, previous solution, and verification results. Reuse the established approach when still correct; do not create a conflicting workaround.
3. **Record every fix.** Every bug fix, data repair, regression prevention change, or operational correction must have a Markdown record under the relevant module folder.
4. **Update this index in the same change.** Add a link, date, short symptom, root cause, resolution, and verification status. A fix is not documented until the index points to it.
5. **One issue, one canonical record.** For recurrence, update the existing record with a dated recurrence section and link the new PR/commit. Create a new record only when the root cause or remediation is materially different.
6. **Be precise about status.** Separate code committed, database changed, tests passed, deployed, and production verified. Never describe an undeployed code fix as live.
7. **Preserve history.** Do not overwrite old decisions or remove previous incident details. Append corrections and explain why a prior decision changed.
8. **No unapproved deployment.** Deployment to Development or Production requires explicit approval for that specific target.

## Module documentation layout

Create module-specific folders as needed:

- `modules/dashboard/` — dashboard cards, totals, charts, display consistency, cache/snapshot behavior.
- `modules/investments/` — holdings, positions, asset mappings, valuation, corporate actions.
- `modules/market-data/` — quotes, NAV, FX, freshness, providers and refresh jobs.
- `modules/accounts/` — CASA, bank accounts, balances and transactions.
- `modules/liabilities/` — credit cards, loans and repayment balances.
- `modules/database/` — schema, migrations, integrity constraints and reconciliation.
- `modules/infra/` — deployment, CI/CD, environment configuration and observability.

- `modules/interest/` — savings and FD interest ledger, statements, rates and sources.
- `modules/obligations/` — planned bills, mandates, recurring commitments and payment alerts.
- `modules/auth/` — login, sessions, roles and access control.
- `modules/integrations/` — Angel One SmartAPI, Exa, Massive and Stock Advisor ingestion.

A fix that spans modules should have one canonical record in the primary/root-cause module and cross-links from other relevant module indexes or records where useful.

## Module reference

Each module folder has a `README.md` describing its files, APIs, tables, rules and known issues. Read it before changing that module.

| Module | Reference |
|---|---|
| Dashboard | [modules/dashboard/README.md](modules/dashboard/README.md) |
| Investments | [modules/investments/README.md](modules/investments/README.md) |
| Market data | [modules/market-data/README.md](modules/market-data/README.md) |
| Accounts & transactions | [modules/accounts/README.md](modules/accounts/README.md) |
| Liabilities | [modules/liabilities/README.md](modules/liabilities/README.md) |
| Interest | [modules/interest/README.md](modules/interest/README.md) |
| Obligations & alerts | [modules/obligations/README.md](modules/obligations/README.md) |
| Auth & security | [modules/auth/README.md](modules/auth/README.md) |
| Integrations | [modules/integrations/README.md](modules/integrations/README.md) |
| Database | [modules/database/README.md](modules/database/README.md) |
| Infrastructure | [modules/infra/README.md](modules/infra/README.md) |

## Fix record template

Each module fix note should include:

- Date and concise title
- Status: investigating / code committed / database repaired / tested / deployed / verified
- Symptoms and expected behavior
- Root cause (confirmed facts separated from hypotheses)
- Affected modules, APIs, tables and jobs
- Previous related fixes reviewed and decision taken
- Resolution and files/commits changed
- Data migration or repair details (including environment)
- Regression tests and exact verification evidence
- Deployment approval and deployment status
- Follow-up actions and known limitations

## Fix history

| Date | Module | Issue | Canonical fix note | Status |
|---|---|---|---|---|
| 2026-11-10 | Dashboard / Investments | US holding INR totals and row values used different fallback rules; recurrence confirmed in Development screenshot | [US holdings total mismatch](modules/dashboard/2026-11-10-us-holdings-total-mismatch.md) | Deployed to Production (fix branch merged into `main`) |
| 2026-11-10 | Auth | Password reset with only the shared key; no password policy, rate limit or session revocation | [Auth hardening](modules/auth/2026-11-10-auth-hardening.md) | Deployed to Production 2026-11-10 (Plan 1) |
| 2026-11-10 | Database / Market data / Investments | Deploys reset live prices; no baseline schema; duplicated facts; cross-user references possible; unlinked obligations and interest | [Versioned migrations, keys, account hierarchy](modules/database/2026-11-10-versioned-migrations-and-keys.md) | Migrations 0000–0005 applied to Development and Production; app code deployed 2026-11-10 (Plan 1) |
| 2026-11-11 | Infra | Production deploy of `main` failed: 14 functions > Hobby limit of 12 | [Single-function router](modules/infra/2026-11-11-hobby-function-limit-single-router.md) | Deployed to Production (`696a71d`, later `2a2afde`) |
| 2026-11-10 | Dashboard / Accounts | Spending stats ignored transactions beyond 500; broken regexes, tooltips and entry form | [Spending stats and UI fixes](modules/dashboard/2026-11-10-spending-stats-and-ui-fixes.md) | Deployed to Production 2026-11-10 (Plan 1) |
| 2026-11-11 | Interest | A day with a correction showed only the correction (−₹7.21); month total ignored days after the statement | [Interest view totals](modules/interest/2026-11-11-interest-view-day-and-month-totals.md) | Deployed to Production |
| 2026-11-11 | Interest / Accounts | Daily-credited interest did not raise the bank balance | [Plan 3 §14.1](plans/claude-plan-3.md) (migration 0009; estimated balance) | Deployed to Production |
| 2026-11-11 | Interest | FDs had no terms, so no interest was calculated; the Interest page could not show FDs (FD rows overwrote Slice Savings) | [FD interest](modules/interest/2026-11-11-fd-interest-in-interest-view.md) | In Production (main `8edae9b`, plan-3o); FD terms set, 5–10 Nov accrued |
| 2026-11-11 | Accounts | Slice Savings left the bank total after an external writer set it to pending_reconciliation | [Account history](modules/accounts/2026-11-11-supermoney-upi-history.md) | Fixed in Production (status estimated) |
| 2026-11-11 | Tools | "Other records" showed only some saved records, with no clear name, search or grouping | [Records page](modules/accounts/2026-11-11-records-page.md) | Deployed (main `b8d040a`, plan-3p) |
| 2026-11-11 | Menu | "Financial overview" in the More menu repeated Home (owner: "remove finacial overview", "menu oly") | — (menu item removed; balance summary kept) | Deployed (main `f27100f`, plan-3q) |
| 2026-11-11 | Dashboard | Dashboard v2 (account model) made the default (owner: "set v2 default") | [v2 dashboard default](modules/dashboard/2026-11-11-v2-dashboard-default.md) | Code on `claude-dev` (plan-3r), not deployed |
| 2026-11-11 | Charts | Charts showed one point at a time, with no filter or zoom (owner: "all chart touch to show data, filter and zoom") | [Interactive charts](modules/dashboard/2026-11-11-interactive-charts.md) | Code on `claude-dev` (plan-3t), not deployed |
| 2026-11-11 | Speed | Dashboard never cached; other caches could be stale after outside writes | [Versioned Redis cache](modules/infra/2026-11-11-versioned-redis-cache.md) | In Production (`35b2934`, 0018); Redis in Mumbai — Singapore move optional |
| 2026-11-11 | Infra | Every branch built on Vercel; only `main` should | [Vercel builds main only](modules/infra/2026-11-11-vercel-build-main-only.md) | Deployed |
| 2026-11-11 | Accounts / Dashboard | Bank balances menu disagreed with the dashboard; account details used static snapshot data and other banks' rows | [Bank balances from the database](modules/accounts/2026-11-11-bank-balances-live-and-account-details.md) | Deployed to Production |
| 2026-11-11 | Database | Audit log stored whole rows and no-op updates; unused price history; a new estimated row every night | [Store only required data (0010)](modules/database/2026-11-11-store-only-required-data.md) | Deployed to Production |
| 2026-11-11 | Investments | Investments menu showed ₹20,272 (money put in + FD) vs dashboard ₹3,83,641; holdings came from snapshots | [Investments page from holdings](modules/investments/2026-11-11-investments-page-from-holdings.md) | Deployed to Production (`041fc03`) |
| 2026-11-11 | Accounts | Activity page had no totals, raw dates, a delete button on every row, filters that reset during background loading | [Activity page redesign](modules/accounts/2026-11-11-activity-page-redesign.md) | Deployed to Production (`041fc03`) |
| 2026-11-11 | Investments / Market data | Dashboard Angel One "Today's gain" showed ₹0; invested and P&L came from the 10 Nov snapshot | [Angel One today's gain](modules/investments/2026-11-11-angel-one-today-gain.md) | Deployed to Production (`041fc03`) |
| 2026-11-11 | Integrations / Investments | Angel One ledger statement had nowhere to go; no lifetime "money put in" or broker charges | [Angel One ledger history (0011)](modules/integrations/2026-11-11-angel-one-ledger-history.md) | In Production (`4d2a262`; 0011 applied, statement imported) |
| 2026-11-11 | Accounts | super.money UPI history: 8 Slice Savings payments missing; 93 Slice card payments stored twice (₹1,26,297.54) | [super.money UPI history](modules/accounts/2026-11-11-supermoney-upi-history.md) | 8 payments, super.money and Paytm reference records, and 1,014 Paytm 2023-24 transactions applied to Production; 93 duplicates marked, then deleted on owner request (backup taken); HDFC ••9498 statements Apr 2025 – Nov 2026 imported (638 rows); 2 self transfers stored as income relabelled |

## Plans

| Date | Plan | Status |
|---|---|---|
| 2026-11-11 | **[TSD — Claude Plan 3: data quality, in-app automation, operations](plans/claude-plan-3.md)** | **v1.3 — deployed to Production 2026-11-11** (`b8d040a`, migrations 0008–0011); changes after v1.2 in §14.7–14.16; owner settings open — see §14.6 ([runbook](ops/operations-runbook.md)) |
| 2026-11-11 | **[TSD — Claude Plan 4: rewards & points, money lent, voucher advisor](plans/claude-plan-4.md)** | **v0.2** — Part 0 in Production (0012, 0013); Part A (Rewards, 0014–0015) built on `claude-dev`, rehearsed on Development; Parts B–C wait for D4–D6 |
| 2026-11-10 | **[TSD — Claude Plan 2: account model cut-over](plans/claude-plan-2.md)** | In progress: A.3, B, G, D.1 in Production; C done via Plan 3; D.2 (switch to v2), E, F not started |
| 2026-11-10 | **[TSD — Claude Plan 1: stabilisation, security and account hierarchy](plans/claude-plan-1.md)** (master technical specification; links the plans below) | **Deployed to Production 2026-11-10** (data model still v1) |
| 2026-11-10 | [Database optimization](plans/2026-11-10-database-optimization-plan.md) | Superseded by the TSD |
| 2026-11-10 | [Data normalization — no duplicates, PK/FK](plans/2026-11-10-data-normalization-design.md) | Implemented as migration 0002; Stage-2 repair script ready, not run |
| 2026-11-10 | [Account hierarchy model — user → account (CASA/Investment/Liability) → subtype → data](plans/2026-11-10-account-hierarchy-model.md) | Implemented as migrations 0003–0004 and the v2 dashboard |

## Reliability project

See [Wealth Reliability & Data Integrity](WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md) for system-wide invariants, workstreams, test requirements and release safety rules.
