# Wealth — Free-First Product Roadmap

**Status:** Proposed plan  
**Delivery model:** Phased  
**Data ingestion priority:** Gmail-first source discovery and archival  
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
3. **Preserve source evidence.** Retain traceability to source emails, attachments, and statements; do not discard original evidence after parsing.
4. **Free-first, not free-at-any-cost.** Use existing services and free allowances where suitable, but do not compromise security, reliability, or provider terms.
5. **Graceful degradation.** Optional AI, Redis, market data, and external services must not make core financial records unavailable.
6. **Evidence-backed balances.** Clearly distinguish verified balances from estimates and stale values.
7. **Small, reversible phases.** Each phase has measurable acceptance criteria and a review gate.
8. **Production is protected.** Development rehearsal and explicit Production approval are mandatory.

## 3. Scope priorities

### P0 — Financial trust and operational safety

- Reconcile account, transaction, balance, investment, and liability models.
- Identify duplicate or conflicting calculation paths.
- Verify dashboard totals against underlying records.
- Surface stale prices, stale balances, missing data, and failed scheduled jobs.
- Review MTF exposure and interest-cost calculations.
- Verify backups and restore procedures without changing Production data.

### P1 — Gmail data discovery, archival and ingestion foundation

- Discover financial emails across Gmail, including Inbox and archived mail; search all relevant historical periods.
- Classify bank transaction alerts, paid transactions, UPI/IMPS/NEFT/RTGS, credits, refunds, auto-debits, NACH, SIPs, EMIs, subscriptions, insurance, salary, bills, credit-card activity, broker notices, trades, margin, holdings, dividends, and investment statements.
- Discover statement/document attachments from banks, cards, brokers, depositories, mutual funds, insurers, lenders, and other financial providers.
- Preserve source message IDs, sender, received date, subject, attachment metadata, file hashes, and extraction status for traceability and deduplication.
- Archive original documents in private storage with controlled access and retention rules; do not modify or delete Gmail messages.
- Extract documents into a staging/review layer before any financial-ledger write.
- Detect missing statement periods, duplicate documents, overlapping statements, and gaps between transaction alerts and statements.
- Reconcile transaction notifications against official statements; statements are evidence for reconciliation, not a reason to double-import the same transaction.
- Maintain a document-password vault keyed by verified sender/institution identity and document type. Store only encrypted password values; keep encryption keys outside the database.
- When a new or changed PDF password is required, request it from the owner through an authenticated Wealth interface, test it against the document, then securely save it for future documents of that sender/type.
- Never put document passwords in logs, email, ordinary application text, or AI prompts.
- Preserve the existing rule that interest is recorded only by the authorised nightly job; do not import statement interest summaries or running interest totals as duplicate income.
- Preserve transaction-only write rules, external-reference deduplication, and explicit review/confirmation before imports.

**Gmail discovery scope:** financial-relevant messages across Inbox and archived mail are in scope. Spam, Trash, Drafts, and unrelated personal messages are not ingestion sources by default. Gmail is read-only: do not label, move, archive, trash, delete, reply to, or send messages as part of ingestion.

### P2 — Core wealth visibility

- Net-worth overview across assets and liabilities.
- Income, spending, savings, and cash-flow summaries.
- Account-level balance freshness and evidence status.
- Investment valuation and realised/unrealised performance where data supports it.
- MTF borrowing cost and interest burden visibility.
- Reconciliation and data-quality alerts.

### P3 — Decision support and planning

- Portfolio diversification by sector, instrument, and concentration.
- Risk indicators for leverage and MTF exposure.
- BUY / HOLD / SELL decision-support framework with explicit rationale and data timestamps.
- Financial health score with visible component breakdown.
- Cash-flow and net-worth forecasts with assumptions disclosed.
- What-if scenarios for savings, repayments, and investment allocations.

These features should be advisory. They must not place orders, move money, or silently change balances.

### P4 — Integrated AI advisor

- Natural-language questions about the user's Wealth data.
- Explanations of dashboard movements, portfolio concentration, and borrowing costs.
- Summaries of alerts and proposed next actions.
- Context-aware answers grounded in application-computed figures.
- Provider adapter so the model provider can be changed without rewriting the finance domain.

The AI layer must not invent missing values or independently calculate authoritative balances. It should cite the relevant in-app data period and explain uncertainty. Document passwords, access tokens, and raw sensitive documents must never be sent to AI providers.

### P5 — Automation, reconciliation and import operations

- Daily/weekly summaries and operational alerts.
- Job freshness and failure visibility.
- Scheduled Gmail discovery for newly received financial notifications and statements.
- Browser-side statement parsing and preview where technically feasible.
- User review before importing any transaction.
- Duplicate prevention using stable external references and appropriate matching.
- Backup verification and documented recovery checks.

Statement import must preserve the existing transaction and balance safety rules. Parsing a statement must not automatically certify a balance.

### P6 — Performance, security, and future expansion

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

### Phase 1 — Gmail source discovery and secure archival design

**Purpose:** establish exactly which financial data is available in Gmail and define a secure, repeatable ingestion pipeline before writing financial records.

Work:
- Inventory financial senders, institution domains, notification patterns, statement types, and attachment formats.
- Build a source catalogue mapping sender/document type to expected data and parsing strategy.
- Define Gmail read-only scopes and historical search boundaries.
- Define private document archival, source provenance, checksums, retention, and access controls.
- Define encrypted document-password vault behaviour and owner password-entry flow.
- Define transaction/document staging, review, deduplication, and statement reconciliation.
- Identify unsupported, encrypted, scanned, malformed, or ambiguous documents for manual handling.
- Produce a sample-based extraction accuracy and coverage report.

Exit criteria:
- Financial source catalogue reviewed by the owner.
- Required email categories and document types are mapped.
- No Gmail mutation is required for ingestion.
- Passwords are encrypted at rest with keys held outside PostgreSQL; plaintext is never logged or sent to AI.
- Every staged item can be traced to its source message and attachment.
- Duplicate and overlapping statement behaviour is specified.
- No automatic financial-ledger writes occur during discovery or archival.
- Data gaps and unsupported document types are reported.

### Phase 2 — Financial foundation and controlled ingestion

**Purpose:** make core financial information consistent and trustworthy while enabling owner-approved imports.

Exit criteria:
- Key dashboard totals reconcile to documented source queries.
- Account balances show evidence/freshness status.
- Transaction writes follow the existing transaction-only boundary.
- No duplicate transaction is introduced by supported workflows.
- Imports require explicit review/confirmation.
- MTF exposure and interest calculations have documented test cases.
- Core dashboard remains usable if optional cache services are unavailable.

### Phase 3 — Wealth intelligence

**Purpose:** convert reliable records into transparent decision support.

Exit criteria:
- Diversification and concentration metrics are reproducible.
- Risk indicators expose their inputs and assumptions.
- Health score components are explainable.
- Forecasts distinguish actuals from projections.
- What-if scenarios do not mutate real financial records.
- Recommendations are timestamped and do not imply guaranteed outcomes.

### Phase 4 — Integrated AI advisor

**Purpose:** let the user query and understand their financial data safely.

Exit criteria:
- AI receives only the minimum necessary context.
- Deterministic application results remain authoritative.
- Sensitive credentials and raw account identifiers are excluded from prompts.
- Provider errors and quota exhaustion degrade gracefully.
- AI responses disclose uncertainty and link back to supporting app data.
- No AI action can write transactions, change balances, trade, or deploy.

### Phase 5 — Automation and operational hardening

**Purpose:** make ingestion and financial operations dependable at scale.

Exit criteria:
- Scheduled discovery is observable and idempotent.
- Duplicate detection is tested across email alerts and statements.
- Unsupported or ambiguous rows are clearly reported.
- Scheduled jobs are observable and idempotent.
- Backup recovery has been rehearsed in a non-Production environment.

### Phase 6 — Optimisation and expansion

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
- Plaintext document-password storage or password reuse across unrelated senders/document types without an explicit owner-defined rule.

## 6. Success measures

Track these measures during implementation:

| Area | Measure |
|---|---|
| Financial correctness | Dashboard totals reconcile to source records |
| Data quality | Stale, missing, and conflicting records are visible |
| Transaction integrity | Duplicate import/write rate is zero in tested workflows |
| Gmail coverage | Relevant financial senders and document categories are inventoried |
| Document traceability | Every extracted record links to its source email/document |
| Password safety | No plaintext password in DB, logs, backups, or AI prompts |
| Reconciliation | Statement-vs-alert gaps and duplicates are surfaced |
| MTF control | Exposure and borrowing cost are visible and reproducible |
| Reliability | Scheduled-job success/failure and data freshness are observable |
| AI quality | Answers are grounded in verified application outputs |
| Cost | Incremental recurring cost remains within the approved budget |
| Safety | No unapproved Production writes or deployments |

## 7. Decision log

| Decision | Agreed direction |
|---|---|
| Delivery style | Phased |
| Data ingestion | Gmail-first discovery, archival and staged extraction |
| Gmail access | Read-only; no mailbox mutation |
| Document passwords | Encrypted vault keyed by sender/institution and document type |
| New password handling | Ask owner through authenticated app flow, validate, then store encrypted |
| Financial imports | Stage, deduplicate, reconcile, and require owner confirmation |
| AI integration | Inside the existing Wealth application |
| Production approval | Required for each Production change |
| Cost strategy | Free-first; validate quotas and terms continuously |
| Current activity | Planning/documentation only |

## 8. Risks and dependencies

- Existing documentation may not match the latest Development schema or deployed state.
- Gmail sender addresses/domains and email content are not sufficient alone to authenticate a financial statement; validate source identity and document context.
- Some providers send password-protected PDFs, scanned PDFs, ZIP files, or formats requiring manual review.
- Gmail search coverage, attachment size, API quotas, and OAuth scopes must be verified.
- Free-tier quotas, eligibility, and provider terms can change.
- Vercel Hobby is intended for personal, non-commercial use; confirm suitability before any commercial use.
- External AI providers may have different data-use terms between free and paid tiers.
- Market-price sources may be delayed, incomplete, or change their interfaces.
- Multi-user support requires a deliberate ownership and authorisation redesign.
- Financial correctness depends on clear rules for verified balances, estimates, transactions, and interest accrual.
- Password encryption requires key rotation, access control, and recovery procedures; database-only encryption keys are not acceptable.

## 9. Next recommended step

Complete Phase 0 as a read-only audit, then Phase 1 as Gmail source discovery and secure archival design. Do not begin automatic imports or Phase 2 implementation until the owner reviews the source catalogue, password-vault design, extraction accuracy, and import controls.
