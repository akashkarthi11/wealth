# Wealth — Free-Tier Architecture and Cost Plan

**Status:** Planning assumptions; verify before implementation  
**Objective:** maximise useful capability using existing infrastructure and free allowances  
**Budget principle:** no new recurring spend without an explicit owner decision

## 1. Recommended architecture

Keep the current application architecture as the default:

- Existing Vercel application and API router.
- Existing Neon PostgreSQL database as the durable source of truth.
- Existing Redis integration only where it measurably improves performance.
- Existing market-price integrations, subject to freshness and provider reliability.
- Optional AI provider adapter integrated into the existing application.

Do not introduce another database, backend, or hosting platform merely to obtain a free quota.

## 2. Free-first capability assessment

| Capability | Initial approach | Cost expectation |
|---|---|---|
| Dashboard and financial summaries | Existing app + database | No new service expected |
| Income/spending analytics | SQL and application calculations | No new service expected |
| Portfolio diversification | Deterministic calculations | No new service expected |
| MTF interest-cost analysis | Deterministic calculations using existing records | No new service expected |
| Forecast and what-if tools | Application-side calculations | No new service expected |
| Data-quality alerts | Existing jobs and database | No new service expected |
| Statement preview | Browser-side parsing, if suitable | No server-side file-processing service expected |
| AI advisor | Optional free-tier model quota | Limited; not guaranteed |
| Premium real-time market data | External paid feed if required | Likely additional cost |
| Commercial multi-user hosting | Reassess hosting plan and terms | May require paid plan |

“No new service expected” does not mean zero total operating cost. Existing provider usage, quotas, taxes, and account eligibility still apply.

## 3. Provider considerations

The following are planning references, not permanent guarantees. Check current official pricing, terms, limits, and account-specific eligibility before relying on them.

### Vercel

- The Hobby plan is positioned for personal, non-commercial use.
- Published quotas and fair-use limits can change.
- Do not assume Hobby is appropriate for a commercial or public multi-user Wealth service.
- Monitor function invocations, execution duration, bandwidth, and build usage.
- If commercial use becomes a goal, review the applicable paid plan and terms before launch.

### Neon

- Use the existing database project and avoid unnecessary duplicate projects.
- Free-tier storage, compute, branching, restore, and network allowances are limited and subject to change.
- Monitor database size, compute consumption, connection behaviour, and network transfer.
- Keep Development and Production separated.
- Never use a free-tier limit as a reason to delete financial history or weaken backups.

### Redis

- Redis should remain an optional cache, not a durable ledger.
- Core dashboard and financial records must remain correct when Redis is unavailable.
- Track memory, bandwidth, connections, and operation limits.
- Do not cache sensitive information unnecessarily.
- If Redis limits are reached, prefer graceful degradation or reduced cache use over an unreviewed paid upgrade.

### AI providers

- Free API quotas and available models can change or be region/account dependent.
- Some free tiers may use submitted content to improve provider products; review current data-use terms before sending any financial context.
- Do not send credentials, access tokens, full bank statements, or unnecessary account identifiers.
- Send only the minimum contextual facts required to answer a question.
- Make AI optional and handle quota exhaustion without breaking the core app.
- Keep the provider behind an adapter so changing providers does not require rewriting finance calculations.

## 4. AI data-boundary design

The recommended flow is:

1. The application authenticates and authorises the user.
2. Deterministic domain services calculate the requested financial facts.
3. A context builder selects only the minimum relevant, non-secret facts.
4. The AI provider explains or summarises those facts.
5. The application presents the answer with its data period and limitations.

The AI model must not be the source of truth for:
- Account balances.
- Transaction records.
- Portfolio valuations.
- Interest accrual.
- MTF exposure.
- BUY / HOLD / SELL rule calculations.

Do not allow AI responses to trigger:
- Transaction insertion.
- Balance updates.
- Money movement.
- Broker orders.
- Database migrations.
- Production deployments.

Any future action-taking capability requires a separate design and explicit approval.

## 5. Cost controls

- Reuse existing infrastructure before adding a service.
- Set a monthly review of provider usage and quotas.
- Avoid repeated expensive calculations where safe caching or query optimisation is sufficient.
- Keep cache TTLs and invalidation rules explicit.
- Avoid storing large raw documents when parsed, user-confirmed records are sufficient.
- Use browser-side statement parsing where secure and technically practical.
- Do not silently upgrade a provider plan or enable paid billing.
- Record the reason, expected benefit, and monthly cost before proposing any paid upgrade.

## 6. Upgrade triggers

Consider a paid tier only when at least one measurable trigger is met:

- Core workloads regularly hit documented free limits.
- Reliability or latency is materially affected.
- Required commercial usage is not permitted on the free plan.
- A security, backup, or recovery requirement cannot be met on the free tier.
- A required model or data source is unavailable within acceptable free terms.

Every upgrade proposal should include:
- The limit currently being reached.
- Usage evidence and trend.
- Lower-cost alternatives considered.
- Expected monthly and annual cost.
- Security and data-use implications.
- A rollback or downgrade plan.

## 7. Operating rule

Free-first is a cost strategy, not a reliability strategy. Never weaken financial data integrity, access control, backup practices, or Production safety to remain within a free allowance.
