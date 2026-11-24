# Wealth Spring Backend — GitHub & Oracle Cloud Implementation Plan

**Status:** Architecture approved; implementation not yet deployed  
**Target environment:** Development only  
**Hosting target:** Oracle Cloud Infrastructure (OCI) Always Free Ampere A1 VM  
**Database:** Existing Neon PostgreSQL initially  
**Frontend:** Existing Wealth application on Vercel remains unchanged

## 1. Locked architecture

Three independent GitHub repositories:

| Repository | Application | Responsibility |
|---|---|---|
| `akashkarthi11/wealth-api` | Spring Boot API | Main REST API, authentication integration, ledger and wealth business operations |
| `akashkarthi11/wealth-services` | Spring Boot services | External provider adapters, market-data integrations, AI/research integrations and internal service APIs |
| `akashkarthi11/wealth-batch` | Spring Batch | Durable scheduled/bulk jobs, reconciliation, retries, restartable batch steps and job metadata |

All three applications run as separate Docker containers on the **same OCI VM**. The batch application is not deployed to a separate VM.

## 2. Environments and branch policy

- Each repository has a `development` branch for automatic development deployment.
- Each repository has a `main` branch reserved for production; production deployment is not enabled in this phase.
- Pull requests run build and tests only.
- A push/merge to `development` triggers that repository's deployment workflow.
- No workflow may deploy to production in this phase.

## 3. CI/CD design

Use GitHub Actions hosted runners; do not install a self-hosted runner on the small OCI VM.

For each repository:

1. Checkout source.
2. Set up the agreed Java LTS toolchain and Maven wrapper.
3. Run unit tests and package the application.
4. Build an OCI Ampere-compatible `linux/arm64` Docker image.
5. Publish a versioned image to GitHub Container Registry (GHCR).
6. Connect to the OCI VM over SSH using a dedicated deployment key.
7. Pull the new image and restart only the changed service with Docker Compose.
8. Run a service health check; retain the previous image tag for rollback.

Image tags must include the Git commit SHA. Never deploy an untagged `latest` image as the only rollback reference.

## 4. OCI VM target

Provision one VM in the tenancy home region (currently shown as India South / Hyderabad):

- Shape: `VM.Standard.A1.Flex`
- Initial allocation target: 2 OCPUs and 12 GB RAM total, subject to actual Always Free eligibility and capacity.
- Image: Ubuntu ARM64, explicitly labelled Always Free eligible.
- One public IPv4 address for initial setup; restrict SSH ingress to the administrator's IP where practical.
- Docker Engine and Docker Compose plugin.
- Nginx reverse proxy and HTTPS.
- No Kubernetes; it adds unnecessary operational overhead for three small services.

Before provisioning, verify the account's Always Free limits and ensure total A1 usage does not exceed 2 OCPUs and 12 GB RAM. OCI documents idle-instance reclamation thresholds; monitor CPU, network and memory usage.

## 5. Initial container resource budgets

Starting limits only; tune after observing real usage:

| Component | Initial memory limit |
|---|---:|
| wealth-api | 1.5 GB |
| wealth-services | 1.0 GB |
| wealth-batch | 1.0 GB |
| OS, Docker, Nginx and monitoring | 1.5 GB |
| Unallocated headroom | 7.0 GB |

Set explicit JVM heap limits below each container memory limit. Keep batch concurrency low so batch work cannot starve API requests.

## 6. Database strategy

- Continue using the existing Neon PostgreSQL database during the first migration phase.
- Do not create a second production database or copy financial data as part of initial infrastructure setup.
- Use separate database roles with least privilege for API, services and batch where practical.
- Apply schema changes through versioned Flyway migrations.
- Store Spring Batch metadata in dedicated tables/schema and ensure job repository transactions are configured.
- Use idempotency keys and database constraints for financial writes.
- Never run destructive migrations automatically during application startup or deployment.

A separate development database/branch and sanitized test data must be confirmed before integration tests or migrations are run.

## 7. Secrets and access

GitHub Actions secrets required per environment:

- `OCI_HOST`
- `OCI_SSH_USER`
- `OCI_SSH_PRIVATE_KEY`
- `GHCR_USERNAME`
- `GHCR_TOKEN` (read-only package access on the VM; publish permission in Actions)
- `WEALTH_DATABASE_URL`
- Application-specific secrets and provider API keys

Prefer GitHub Environments for development secrets and required deployment approvals. Keep runtime secrets on the VM in a root-owned environment file with restrictive permissions or another secure secret store. Never commit secrets, database URLs, private keys, account exports or personal financial records.

## 8. API routing

- Keep the current Vercel frontend and existing Node.js backend active during migration.
- Expose new Java APIs behind an Nginx HTTPS hostname, for example `api-dev.<owned-domain>` once a domain is configured.
- Route only explicitly migrated frontend API calls to Spring Boot.
- Preserve compatibility with existing request/response contracts where possible.
- Do not switch all frontend traffic until authentication, authorization, CORS, financial write idempotency and regression tests pass.

## 9. Implementation phases and acceptance criteria

### Phase 0 — Account and access readiness
- Finish OCI account provisioning.
- Confirm the Hyderabad home region and Always Free eligibility.
- Confirm available A1 quota and capacity.
- Create an SSH key pair locally; only the public key is uploaded to OCI.
- Confirm GitHub account can create private repositories and GHCR packages.

**Exit:** OCI console access and a confirmed Always Free VM configuration; no paid upgrade required.

### Phase 1 — Repository foundations
- Create the three private repositories listed above.
- Add `development` and `main` branches.
- Add Maven Wrapper, Java toolchain, baseline Spring Boot app, tests, Dockerfile, health endpoint and README.
- Add repository-level branch protection and Actions permissions.

**Exit:** All three repositories build and pass tests on GitHub Actions.

### Phase 2 — OCI host
- Create one Always Free A1 VM.
- Configure firewall/security list, SSH, Docker, Compose, Nginx and HTTPS.
- Install a minimal deployment directory and Docker Compose configuration.

**Exit:** VM is reachable securely and can run a test ARM64 container.

### Phase 3 — CI/CD
- Create one independent workflow per repository.
- Build and publish ARM64 images to GHCR.
- Deploy only the changed container on a push to `development`.
- Add health checks, deployment logs and rollback instructions.

**Exit:** A test commit to each development branch deploys successfully and can be rolled back.

### Phase 4 — Application development
- Implement API contracts and database access in wealth-api.
- Implement external integrations in wealth-services.
- Implement restartable, idempotent jobs in wealth-batch.
- Add authentication/authorization, audit logging, retries and observability.

**Exit:** Integration tests pass against a development Neon database; no production data is modified.

### Phase 5 — Gradual Wealth integration
- Connect a limited set of frontend routes to the development API.
- Run regression tests for ledger, transactions, balances and scheduled tasks.
- Compare results with the existing backend before migrating more routes.

**Exit:** Development validation is complete. Production cutover requires a separate explicit approval.

## 10. Cost and safety guardrails

- Use only OCI resources labelled **Always Free Eligible**.
- Do not upgrade the tenancy to Pay As You Go.
- Do not create paid compute, paid load balancers, paid databases or paid container services.
- Set OCI budget/cost alerts where available; alerts are not hard spending caps.
- Check OCI usage and resource labels before creating each resource.
- GitHub Actions hosted minutes and GHCR usage are subject to GitHub plan limits and package storage/bandwidth policies; verify current quotas before relying on private images at scale.
- If Always Free A1 capacity is unavailable, wait and retry; do not silently substitute a paid shape.

## 11. Decisions still required before resource creation

1. Confirm the three repository names: `wealth-api`, `wealth-services`, `wealth-batch`.
2. Confirm a domain/subdomain for the development API, or use the VM public IP temporarily.
3. Confirm whether the existing Neon development branch is the intended integration database.
4. Confirm OCI provisioning has completed and the account's A1 quota is visible.

## 12. Current execution boundary

This document is a plan only. No new GitHub repositories, OCI instances, DNS records, secrets, database migrations, or deployments have been created by this change. Development is the only authorized deployment target in this phase.
