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
| 2026-11-10 | Dashboard / Investments | US holding INR totals and row values used different fallback rules; recurrence confirmed in Development screenshot | [US holdings total mismatch](modules/dashboard/2026-11-10-us-holdings-total-mismatch.md) | Unified valuation committed on fix branch; validation and Development deployment pending approval |
| 2026-11-10 | Auth | Password reset with only the shared key; no password policy, rate limit or session revocation | [Auth hardening](modules/auth/2026-11-10-auth-hardening.md) | Code + tests on `claude-dev`; migration 0001 not applied; not deployed |
| 2026-11-10 | Database / Market data / Investments | Deploys reset live prices; no baseline schema; duplicated facts; cross-user references possible; unlinked obligations and interest | [Versioned migrations, keys, account hierarchy](modules/database/2026-11-10-versioned-migrations-and-keys.md) | Migrations 0000–0005 **applied to Development and Production** (backups first, no rows lost); app code not deployed |
| 2026-11-11 | Infra | Production deploy of `main` failed: 14 functions > Hobby limit of 12 | [Single-function router](modules/infra/2026-11-11-hobby-function-limit-single-router.md) | Code + tests on `claude-dev`; not deployed |
| 2026-11-10 | Dashboard / Accounts | Spending stats ignored transactions beyond 500; broken regexes, tooltips and entry form | [Spending stats and UI fixes](modules/dashboard/2026-11-10-spending-stats-and-ui-fixes.md) | Code + tests on `claude-dev`; verified read-only on Preview; not deployed |

## Plans

| Date | Plan | Status |
|---|---|---|
| 2026-11-11 | **[TSD — Claude Plan 3: data quality, in-app automation, operations](plans/claude-plan-3.md)** | Phases 1–6 built on `claude-dev`; 0008 applied to Development; not deployed ([runbook](ops/operations-runbook.md)) |
| 2026-11-10 | **[TSD — Claude Plan 2: account model cut-over](plans/claude-plan-2.md)** | Phase B done (Development applied; Production via next deploy) |
| 2026-11-10 | **[TSD — Claude Plan 1: stabilisation, security and account hierarchy](plans/claude-plan-1.md)** (master technical specification; links the plans below) | **Deployed to Production 2026-11-10** (data model still v1) |
| 2026-11-10 | [Database optimization](plans/2026-11-10-database-optimization-plan.md) | Superseded by the TSD |
| 2026-11-10 | [Data normalization — no duplicates, PK/FK](plans/2026-11-10-data-normalization-design.md) | Implemented as migrations 0002 and repairs |
| 2026-11-10 | [Account hierarchy model — user → account (CASA/Investment/Liability) → subtype → data](plans/2026-11-10-account-hierarchy-model.md) | Implemented as migrations 0003–0004 and the v2 dashboard |

## Reliability project

See [Wealth Reliability & Data Integrity](WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md) for system-wide invariants, workstreams, test requirements and release safety rules.
