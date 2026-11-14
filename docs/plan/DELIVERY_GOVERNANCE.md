# Wealth — Delivery Governance

## 1. Scope and authority

These documents define a proposed roadmap. They do not authorise implementation or operational changes.

The current approved activity is planning and documentation. Separate explicit approval is required before:
- Application code changes.
- Database schema or data changes.
- Environment variable or provider configuration changes.
- New paid services or billing.
- Production deployment or Production writes.
- External AI integration or transmission of financial context.

Approval for one action or environment does not imply approval for another.

## 2. Branch and environment discipline

- Read the repository's `rules.md` on the selected working branch before each Wealth task.
- Respect the branch explicitly selected by the owner.
- Keep Development and Production isolated.
- Use Development for rehearsal and validation.
- Do not merge into or disturb the frozen `v2` branch.
- Do not switch database projects or deployment targets implicitly.
- Obtain explicit approval for each Production change/deployment.

## 3. Financial data safety

- Financial transaction insertion must follow the repository's transaction-only write boundary.
- Do not mutate account balances as a side effect of recording a transaction.
- A balance is verified only when supported by direct bank evidence.
- Estimates must remain labelled as estimates/stale.
- Never use `pending_reconciliation`.
- Interest is recorded only by the application's authorised nightly job; agents must not write interest rows.
- Do not delete financial history or use destructive migrations.
- Verify transaction identity and duplicate handling before and after any import workflow.

## 4. Phase delivery gates

Every implementation phase should include:

1. **Scope:** exact files, routes, tables, and user-visible behaviour affected.
2. **Baseline:** current behaviour and relevant data totals captured without changing Production.
3. **Design:** data flow, failure modes, security boundaries, and rollback strategy documented.
4. **Development rehearsal:** implementation and tests performed against Development only.
5. **Verification:** automated tests plus targeted data-integrity checks.
6. **Review:** owner reviews scope, results, risks, and any remaining limitations.
7. **Production approval:** explicit approval for the exact Production operation.
8. **Post-deployment check:** verify health, logs, key totals, and scheduled jobs; report evidence.

A failed gate blocks progression. Do not represent a planned, partial, or unverified feature as complete.

## 5. Testing expectations

- Unit-test deterministic financial calculations.
- Test rounding, dates, time zones, missing data, stale prices, and boundary conditions.
- Test duplicate transaction/import behaviour.
- Test optional-service failure, including Redis and AI provider outages.
- Test authorisation boundaries for owner-only routes.
- Test migration safety and repeatability in a non-Production environment.
- Reconcile key dashboard outputs against known source records.
- Document any tests not run and why.

## 6. AI-specific governance

- The application remains responsible for authentication, authorisation, and financial calculations.
- AI is an explanatory layer, not an authority for balances or transactions.
- Minimise financial context sent to providers.
- Review provider retention and training/data-use terms before enabling a model.
- Never expose secrets, tokens, or unnecessary account identifiers to prompts or logs.
- Make AI opt-in if provider data-use terms or user expectations require it.
- AI must not write financial records, move money, trade, alter configuration, or deploy.

## 7. Status vocabulary

Use these statuses consistently:

- **Proposed:** included in the roadmap but not approved for implementation.
- **In audit:** being inspected read-only.
- **Approved:** owner approved a defined scope; this does not automatically approve Production.
- **In development:** implementation is underway in the approved Development scope.
- **Verified in Development:** tests and checks passed in Development.
- **Production approved:** owner explicitly approved the specified Production action.
- **Deployed:** change is live and post-deployment checks passed.
- **Blocked:** a dependency, safety issue, or failed gate prevents progress.
- **Deferred:** intentionally postponed.

## 8. Reporting

For each completed task, report:
- What changed.
- Repository branch and commit, if a commit was made.
- Environment affected.
- Tests and verification performed.
- Data/schema impact.
- Remaining risks and follow-up work.

Never claim a write, migration, deployment, or verification succeeded unless it actually did.
