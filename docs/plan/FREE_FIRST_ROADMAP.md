# Wealth — Free-First Product Roadmap

**Status:** Proposed plan  
**Delivery model:** Phased  
**AI direction:** Integrated into the existing Wealth application  
**Cost objective:** ₹0 incremental recurring infrastructure spend where practical  
**Production policy:** Explicit approval required before every Production change

## 1. Vision

Build Wealth into a reliable personal finance and investment operating system that helps the owner understand:

- What they own, owe, earn, spend, save, and invest.
- Whether account balances and financial records are trustworthy and up to date.
- How portfolio concentration, leverage, and MTF borrowing affect risk.
- Which actions deserve attention, supported by transparent calculations.
- How to ask questions about their own financial data through an integrated AI assistant.

The product should prioritise correctness, explainability, and dependable records over adding features quickly.

## 2. Guiding principles

1. **Correctness before intelligence.** Financial totals and risk calculations must come from deterministic application logic, not an LLM.
2. **One source of truth.** Reuse the existing database and domain model; avoid parallel ledgers and duplicate financial calculations.
3. **Free-first, not free-at-any-cost.** Use existing services and free allowances where suitable, but do not compromise security, reliability, or provider terms.
4. **Graceful degradation.** Optional AI, Redis, market data, and external services must not make core financial records unavailable.
5. **Evidence-backed balances.** Clearly distinguish verified balances from estimates and stale values.
6. **Small, reversible phases.** Each phase has measurable acceptance criteria and a review gate.
7. **Production is protected.** Development rehearsal and explicit Production approval are mandatory.

## 3. Scope priorities

### P0 — Financial trust and operational safety

- Reconcile account, transaction, balance, investment, and liability models.
- Identify duplicate or conflicting calculation paths.
- Verify dashboard totals against underlying records.
- Surface stale prices, stale balances, missing data, and failed scheduled jobs.
- Review MTF exposure and interest-cost calculations.
- Verify backups and restore procedures without changing Production data.

### P1 — Core wealth visibility

- Net-worth overview across assets and liabilities.
- Income, spending, savings, and cash-flow summaries.
- Account-level balance freshness and evidence status.
- Investment valuation and realised/unrealised performance where data supports it.
- MTF borrowing cost and interest burden visibility.
- Reconciliation and data-quality alerts.

### P2 — Decision support and planning

- Portfolio diversification by sector, instrument, and concentration.
- Risk indicators for leverage and MTF exposure.
- BUY / HOLD / SELL decision-support framework with explicit rationale and data timestamps.
- Financial health score with visible component breakdown.
- Cash-flow and net-worth forecasts with assumptions disclosed.
- What-if scenarios for savings, repayments, and investment allocations.

These features should be advisory. They must not place orders, move money, or silently change balances.

### P3 — Integrated AI advisor

- Natural-language questions about the user's Wealth data.
- Explanations of dashboard movements, portfolio concentration, and borrowing costs.
- Summaries of alerts and proposed next actions.
- Context-aware answers grounded in application-computed figures.
- Provider adapter so the model provider can be changed without rewriting the finance domain.

The AI layer must not invent missing values or independently calculate authoritative balances. It should cite the relevant in-app data period and explain uncertainty.

### P4 — Automation and statement-assisted imports

- Daily/weekly summaries and operational alerts.
- Job freshness and failure visibility.
- Browser-side statement parsing and preview where technically feasible.
- User review before importing any transaction.
- Duplicate prevention using stable external references and appropriate matching.
- Backup verification and documented recovery checks.

Statement import must preserve the existing transaction and balance safety rules. Parsing a statement must not automatically certify a balance.

### P5 — Performance, security, and future expansion

- Optimise repeated queries and expensive dashboard calculations.
- Keep caching optional and observable.
- Improve mobile performance and usability.
- Review authentication, authorisation, secrets, auditability, and data minimisation.
- Assess multi-user architecture only after single-owner correctness and access boundaries are proven.
- Reassess hosting and database tiers against actual usage.

A public multi-user SaaS launch is not part of the initial free-first scope.

## 4. Phases and exit criteria

### Phase 0 — Read-only audit and plan validation

**Purpose:** establish what exists, what is safe, and what should be reused before implementation.

Work:
- Read current operating rules and inspect the active Development branch.
- Map routes, domain modules, data tables, migrations, scheduled jobs, and external integrations.
- Compare current schema/migration state with documentation.
- Identify duplicated calculations and conflicting sources of truth.
- Review dashboard totals and investment/MTF calculations.
- Review current service usage and free-tier constraints.
- Produce a prioritised gap list, dependency map, and implementation sequence.

Exit criteria:
- Current architecture and data flows documented.
- Implemented, partial, planned, and unknown features clearly distinguished.
- Data integrity and security risks prioritised.
- Free-tier assumptions and upgrade triggers documented.
- No unresolved high-risk ambiguity hidden inside an implementation estimate.

**Execution boundary:** read-only inspection and documentation only unless the owner separately authorises a specific change.

### Phase 1 — Financial foundation

**Purpose:** make core financial information consistent and trustworthy.

Exit criteria:
- Key dashboard totals reconcile to documented source queries.
- Account balances show evidence/freshness status.
- Transaction writes follow the existing transaction-only boundary.
- No duplicate transaction is introduced by supported workflows.
- MTF exposure and interest calculations have documented test cases.
- Core dashboard remains usable if optional cache services are unavailable.

### Phase 2 — Wealth intelligence

**Purpose:** convert reliable records into transparent decision support.

Exit criteria:
- Diversification and concentration metrics are reproducible.
- Risk indicators expose their inputs and assumptions.
- Health score components are explainable.
- Forecasts distinguish actuals from projections.
- What-if scenarios do not mutate real financial records.
- Recommendations are timestamped and do not imply guaranteed outcomes.

### Phase 3 — Integrated AI advisor

**Purpose:** let the user query and understand their financial data safely.

Exit criteria:
- AI receives only the minimum necessary context.
- Deterministic application results remain authoritative.
- Sensitive credentials and raw account identifiers are excluded from prompts.
- Provider errors and quota exhaustion degrade gracefully.
- AI responses disclose uncertainty and link back to supporting app data.
- No AI action can write transactions, change balances, trade, or deploy.

### Phase 4 — Automation and imports

**Purpose:** reduce manual work without weakening data controls.

Exit criteria:
- Imports provide a preview and explicit confirmation.
- Duplicate detection is tested.
- Unsupported or ambiguous rows are clearly reported.
- Scheduled jobs are observable and idempotent.
- Backup recovery has been rehearsed in a non-Production environment.

### Phase 5 — Optimisation and expansion

**Purpose:** improve reliability and decide whether paid capacity or multi-user support is justified.

Exit criteria:
- Performance bottlenecks are measured before and after optimisation.
- Security review is complete.
- Usage is compared with current plan limits.
- Any paid upgrade has a documented reason and expected value.
- Multi-user expansion has a separate ownership, authorisation, and data-isolation design.

## 5. What should remain out of scope initially

- Paid AI subscriptions or high-volume model usage.
- Paid market-data feeds unless a clear requirement and budget are approved.
- Additional databases or hosting platforms without measured need.
- A public commercial SaaS launch on a plan whose terms do not permit it.
- Expensive monitoring platforms before basic operational visibility is sufficient.
- Automatic trading, money movement, or balance mutation driven by AI.
- Replacing working infrastructure solely for novelty.

## 6. Success measures

Track these measures during implementation:

| Area | Measure |
|---|---|
| Financial correctness | Dashboard totals reconcile to source records |
| Data quality | Stale, missing, and conflicting records are visible |
| Transaction integrity | Duplicate import/write rate is zero in tested workflows |
| MTF control | Exposure and borrowing cost are visible and reproducible |
| Reliability | Scheduled-job success/failure and data freshness are observable |
| AI quality | Answers are grounded in verified application outputs |
| Cost | Incremental recurring cost remains within the approved budget |
| Safety | No unapproved Production writes or deployments |

## 7. Decision log

| Decision | Agreed direction |
|---|---|
| Delivery style | Phased |
| AI integration | Inside the existing Wealth application |
| Production approval | Required for each Production change |
| Cost strategy | Free-first; validate quotas and terms continuously |
| Current activity | Planning/documentation only |

## 8. Risks and dependencies

- Existing documentation may not match the latest Development schema or deployed state.
- Free-tier quotas, eligibility, and provider terms can change.
- Vercel Hobby is intended for personal, non-commercial use; confirm suitability before any commercial use.
- External AI providers may have different data-use terms between free and paid tiers.
- Market-price sources may be delayed, incomplete, or change their interfaces.
- Multi-user support requires a deliberate ownership and authorisation redesign.
- Financial correctness depends on clear rules for verified balances, estimates, transactions, and interest accrual.

## 9. Next recommended step

Complete Phase 0 as a read-only audit and produce a verified gap report. Do not begin Phase 1 implementation until the owner reviews the findings and explicitly approves the scope.
