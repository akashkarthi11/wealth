# Wealth — Planning Documents

This directory contains the forward-looking product and engineering plan for Wealth.

## Documents

| Document | Purpose |
|---|---|
| [Free-First Roadmap](./FREE_FIRST_ROADMAP.md) | Phased product roadmap, priorities, scope, and completion criteria |
| [Free-Tier Architecture & Cost Plan](./FREE_TIER_ARCHITECTURE.md) | Infrastructure strategy, free-tier assumptions, cost controls, and upgrade triggers |
| [Delivery Governance](./DELIVERY_GOVERNANCE.md) | Phase gates, testing expectations, data safety, and Production approval |

## Current planning decisions

- **Delivery approach:** phased.
- **AI approach:** integrate AI into the existing Wealth application; do not create a separate AI product or duplicate backend.
- **Cost objective:** achieve the highest useful capability with existing services and free allowances first.
- **Production governance:** explicit owner approval is required for each Production change/deployment.
- **Current execution boundary:** planning and documentation only. No implementation, database changes, configuration changes, or deployment are authorised by these documents.

## How to use this plan

1. Treat the roadmap as proposed work, not proof that a feature is implemented.
2. Complete the read-only Phase 0 audit before committing to implementation estimates.
3. Update phase status only after evidence-backed verification.
4. Re-check provider pricing, quotas, terms, and account eligibility before relying on a free tier.
5. Keep Production protected and rehearse database/schema changes in Development first.

Last updated: 2026-11-11.
