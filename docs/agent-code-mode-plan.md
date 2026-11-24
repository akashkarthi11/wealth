# Wealth Agent Code Mode — Implementation Plan

**Status:** Proposed  
**Target branch:** `development`  
**Scope:** Planning document only; this change does not implement or enable Code Mode.

## 1. Goal

Add a controlled Code Mode capability to Wealth so the agent can compose multiple existing Wealth tools into one multi-step workflow using short JavaScript programs, while preserving the current agent/tool architecture and the application's security boundaries.

The initial release should improve multi-step **read-only** research and operational analysis. It must not become an unrestricted database console, general-purpose shell, or alternative path around existing Wealth APIs.

## 2. Recommended approach

Use a **hybrid architecture**:

- Keep the existing Wealth Agent Search and Agent Tools as the source of truth for tool discovery and individual operations.
- Add a Code Mode Executor that lets the model compose approved tool calls into a bounded JavaScript workflow.
- Reuse existing provider integrations, API-key routing, authorization, usage accounting, and job infrastructure wherever practical.
- Run generated code in an isolated sandbox/runtime (evaluate Cloudflare Code Mode / Workers as the first proof-of-concept option). Do not execute model-generated JavaScript with unrestricted `eval`, `Function`, or Node.js privileges inside the Vercel application runtime.
- Keep Wealth's user-facing application and existing APIs on their current hosting architecture. Treat the sandbox as a separate execution boundary.

Code Mode is an emerging/experimental integration surface. Validate current SDK/API compatibility, operational limits, and deployment requirements in a small proof of concept before committing to a production dependency.

## 3. High-level architecture

```text
User
  |
  v
Wealth Agent (existing)
  |-- Agent Search: discover permitted tools
  |-- Agent Tools: existing single-tool execution
  |
  +--> Code Mode Planner / Executor (new)
          |
          |  generated, bounded JavaScript
          v
      Isolated sandbox
          |
          |  brokered tool requests only
          v
      Wealth Tool Gateway (host-controlled)
          |-- authenticate user and enforce ownership
          |-- authorize each tool and validate arguments
          |-- apply rate / time / call-count limits
          |-- route to existing Wealth APIs and providers
          |-- record usage and execution audit
          v
      Existing application services / providers / database
```

The sandbox must not receive database credentials, provider secrets, unrestricted network access, filesystem access, or direct access to internal infrastructure. Tool calls should be brokered through host-controlled handlers; secrets remain in the host/provider layer.

## 4. Phased delivery

### Phase 0 — Discovery and technical spike

- Inspect the current Agent Search, Agent Tools, provider routing, API usage tracking, authentication, job queue, and test structure.
- Map existing tools into read-only, state-changing, and privileged categories.
- Verify the current Code Mode SDK/runtime interface, supported JavaScript environment, timeout and memory limits, tool-call behavior, and deployment model.
- Build a minimal isolated proof of concept using mock/read-only tools; do not connect it to Production data.
- Compare the proof of concept with the current direct Agent Tools flow for reliability, latency, token usage, and operational complexity.

**Exit criteria:** A working sandbox spike, documented limitations, and a decision to proceed, revise the design, or stop. No Production integration is required for this phase.

### Phase 1 — Read-only Code Mode MVP

Enable a small allowlist of read-only workflows, for example:

- Portfolio and allocation summaries using existing authorized read APIs.
- Provider availability/capability comparisons.
- API usage and cost summaries.
- Job status and execution-history inspection.
- Read-only diagnostics over application-level data already exposed by approved tools.

Requirements:

- Discoverable tool schemas with clear descriptions and input validation.
- User-scoped authorization enforced by the host for every tool call.
- Bounded execution time, memory, source size, tool-call count, and output size.
- Structured result envelope with success/failure, useful output, and trace/execution ID.
- Cancellation and timeout handling.
- Audit trail for the user, workflow, tool calls, timestamps, and outcome (without logging secrets).
- Usage/cost accounting integrated with existing Wealth reporting.

**Exit criteria:** All MVP workflows pass authorization, isolation, timeout, error-handling, and regression tests. No write-capable tool is exposed to the executor.

### Phase 2 — Reliability and observability

- Add execution tracing across planner, sandbox, gateway, and downstream tools.
- Add per-user and per-workflow quotas and concurrency controls.
- Add clear error categories: validation, authorization, tool failure, timeout, sandbox failure, and provider failure.
- Add safe retries only for operations known to be idempotent.
- Add metrics for success rate, latency, tool calls, token usage, and estimated execution cost.
- Add an operator kill switch and feature flag; default the feature off until explicitly enabled.
- Evaluate prompt-injection and untrusted tool-result handling. Treat all retrieved content as data, never as executable instructions.

**Exit criteria:** Operators can observe, limit, disable, and diagnose Code Mode without affecting existing Agent Tools.

### Phase 3 — Approval-gated actions (later release)

Only after the read-only release is stable, consider narrowly scoped state-changing workflows.

- Keep write tools disabled by default.
- Require a clear preview of the exact action, target, and affected records.
- Require explicit user approval immediately before execution.
- Re-check authorization and relevant state after approval; do not trust an earlier plan as authorization.
- Use idempotency keys and duplicate detection where applicable.
- Return a verifiable operation ID and final status.
- Require separate approvals or prohibit high-impact actions such as financial transactions, balance changes, database migrations, Production writes, deployments, and destructive operations.

Code Mode must never bypass Wealth's existing business rules or operating instructions.

## 5. Security and data boundaries

| Area | Required control |
|---|---|
| Identity | Bind every execution to the authenticated Wealth user and tenant context. |
| Authorization | Enforce permissions in host-side tool handlers on every call, not only in the model prompt. |
| Secrets | Keep provider keys, database credentials, and signing secrets outside generated code and sandbox results. |
| Network | No unrestricted outbound network from generated code; broker only explicitly approved tool requests. |
| Database | No direct database connection from the sandbox. Use existing application services and scoped APIs. |
| Isolation | Separate execution runtime from the Vercel app process; no unrestricted Node.js, shell, filesystem, or process access. |
| Resource limits | Enforce wall-clock timeout, memory, source size, tool-call count, concurrency, and output limits. |
| Approval | Require explicit confirmation for any enabled state-changing action. |
| Audit | Record execution and tool-call metadata while redacting credentials and sensitive payloads. |
| Kill switch | Provide a fast global and per-user disable path. |

### Wealth-specific invariants

- Production remains protected. Development work and testing must use Development resources only.
- Do not alter account balances as a side effect of transaction insertion.
- Interest rows are written only by the application's nightly `/api/nightly` job; Code Mode and agents must not create or update interest rows.
- Transaction insertion rules remain centralized in existing Wealth services; do not expose a direct SQL tool.
- Existing branch and deployment rules remain in force. This plan targets `development` and does not authorize changes to `main`, `v1`, or `v2`.

## 6. Integration points to inspect before implementation

The implementation phase must verify the actual current code and contracts before choosing exact files or APIs:

1. Agent Search: tool discovery, schemas, filtering, and user context.
2. Agent Tools: execution dispatch, validation, authorization, and error mapping.
3. Provider routing: provider selection, API-key isolation, and fallback behavior.
4. API usage: token/cost accounting and attribution to the initiating user/workflow.
5. Job queue: whether long-running workflows should be synchronous or queued.
6. Authentication and data access: user/tenant scoping and existing service boundaries.
7. Tests: existing mocks, integration-test conventions, and regression coverage.

Do not duplicate an existing capability if the current gateway can safely support it.

## 7. Testing and acceptance checklist

- [ ] Sandbox executes only within the configured isolation boundary.
- [ ] Generated code cannot access environment secrets, database credentials, filesystem, shell, or unrestricted network.
- [ ] Every tool call is authenticated, user-scoped, authorized, and schema-validated.
- [ ] Unauthorized tool calls are rejected by the host even if requested by generated code.
- [ ] Time, memory, source-size, call-count, output-size, and concurrency limits are enforced.
- [ ] Timeout, cancellation, malformed code, tool errors, and sandbox errors return safe structured responses.
- [ ] Untrusted tool output cannot silently grant new instructions or permissions.
- [ ] Usage and execution audit records are accurate and do not leak secrets.
- [ ] Existing Agent Search and Agent Tools behavior remains unchanged when Code Mode is disabled.
- [ ] Read-only MVP exposes no write-capable tools.
- [ ] Wealth-specific transaction, balance, interest, and Production protections remain intact.
- [ ] Feature flag and kill switch are tested.
- [ ] Regression tests pass before enabling the feature for users.

## 8. Rollout and success measures

1. Local/mock spike.
2. Development-only read-only integration.
3. Internal testing with a small allowlist of workflows.
4. Limited opt-in release behind a feature flag.
5. Broader rollout only after reliability and security review.

Track:

- Workflow success rate and correctness.
- Median and tail latency.
- Tool calls per workflow.
- Token usage and total cost compared with direct Agent Tools.
- Timeout and sandbox failure rates.
- Authorization denials and security events.
- Regression impact on existing agent workflows.

A successful rollout should reduce orchestration overhead for multi-step tasks without weakening security, increasing operational cost unexpectedly, or changing existing Wealth business rules.

## 9. Decisions still required

These are implementation decisions, not assumed facts:

- Which sandbox/runtime and SDK version to adopt after the spike.
- Whether execution is synchronous, queued, or a hybrid based on workflow duration.
- Which exact read-only tools are included in the first allowlist.
- Retention period and detail level for execution traces.
- Per-user quotas, concurrency limits, and cost ceilings.
- Whether Phase 3 write actions are needed at all.

## 10. Immediate next steps

1. Review the current Agent Search and Agent Tools implementation on `development`.
2. Produce a tool inventory with permissions and data classifications.
3. Implement a mock-only sandbox spike and benchmark it against direct tool orchestration.
4. Record the runtime decision and threat model before integrating real read-only tools.
5. Build the read-only MVP behind a disabled-by-default feature flag.

---

**Non-goal of this document:** This plan does not authorize database migrations, Production changes, deployment changes, or state-changing agent actions.
