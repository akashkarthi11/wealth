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

A fix that spans modules should have one canonical record in the primary/root-cause module and cross-links from other relevant module indexes or records where useful.

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
| 2026-11-10 | Dashboard / Investments / Accounts / Liabilities | Future-dated EPF, pending FD, saved-FX US holdings and active portfolio aggregates distorted confirmed net worth | [Net worth valuation reconciliation](modules/dashboard/2026-11-10-net-worth-valuation-reconciliation.md) | Code and regression tests committed on feature branch; Development preview verification pending |

## Reliability project

See [Wealth Reliability & Data Integrity](WEALTH_RELIABILITY_AND_DATA_INTEGRITY.md) for system-wide invariants, workstreams, test requirements and release safety rules.
