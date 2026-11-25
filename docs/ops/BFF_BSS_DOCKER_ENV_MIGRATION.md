# BFF/BSS Docker and Environment Configuration Migration

**Status date:** 2026-11-25  
**Target branch:** `development`  
**Scope:** Wealth frontend deployment topology, Spring Boot BFF/BSS configuration, Docker deployment, and Vercel environment migration planning.

## 1. Current architecture

The application is split into separate frontend, BFF, and BSS components.

```text
Browser
  |
  v
Vercel Wealth frontend
  |
  v
BFF (Oracle Docker, host network, port 8081)
  |
  | http://127.0.0.1:8080
  v
BSS (Oracle Docker, loopback-bound port 8080)
  |
  +--> Neon PostgreSQL (development branch)
  |
  +--> Redis (Vercel Redis integration)
```

- BFF proxies `/wealth/api/v1/**` requests to the BSS `/wealth-service/api/v1/**` API.
- BFF and BSS run as separate Docker containers on the Oracle VM.
- BFF uses host networking and listens on port `8081`.
- BSS publishes port `8080` on loopback only (`127.0.0.1:8080`).
- The BFF-to-BSS address is therefore `http://127.0.0.1:8080`.

## 2. Work completed

### BFF repository — `akashkarthi11/wealth-bff`

Branch: `development`

- Added `src/main/resources/application.yml`.
- Added Spring profile sections for `dev` and `prod`.
- Configured the server port using `SERVER_PORT`.
- Configured the BSS base URL using `WEALTH_BSS_BASE_URL`.
- Removed the previous `application.properties` so there is one configuration file.
- Updated the deployment workflow to activate `SPRING_PROFILES_ACTIVE=dev`.
- Updated the Docker deployment environment to pass the BSS base URL and development profile.

Relevant commits:
- YAML configuration: `33cc5315f2e22b5f3a2013b417e983c1dc9c8fd2`
- Development deployment profile: `9891d4e0082ae261bbce8d3a28154c5746adf91f`

### BSS repository — `akashkarthi11/wealth-bss`

Branch: `development`

- Added `src/main/resources/application.yml`.
- Added Spring profile sections for `dev` and `prod`.
- Added environment-backed configuration for:
  - Neon JDBC URL
  - Database username and password
  - Database connection pool size
  - Redis URL and connection timeouts
  - Session secret
  - Application access key
  - Server port
- Updated `WealthJdbcConfiguration` to read the normalized `wealth.jdbc.*` properties from YAML.
- Removed the previous `application.properties`.
- Updated the deployment workflow to activate `SPRING_PROFILES_ACTIVE=dev`.
- Updated Docker runtime environment mapping for JDBC, Redis, session and access-key settings.

Relevant commits:
- YAML configuration: `11b52f3268715deb246453be1b3bdfccf354a710`
- JDBC configuration binding: `56787a61c96a7a4d997d0972888cd6aa1f3f3a06`
- Development deployment profile: `f005fdcb5e36199c3967d6cd8cfa175549e8370d`

## 3. Environment configuration contract

### BFF

| Variable | Purpose | Development deployment value |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | Spring profile | `dev` |
| `SERVER_PORT` | BFF listen port | `8081` |
| `WEALTH_BSS_BASE_URL` | Internal BSS URL | `http://127.0.0.1:8080` |

### BSS

| Variable | Purpose | Source |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | Spring profile | Deployment workflow |
| `SERVER_PORT` | BSS listen port | Default `8080` |
| `WEALTH_JDBC_URL` | Neon PostgreSQL connection | GitHub Actions secret |
| `WEALTH_DB_USERNAME` | Optional database username override | GitHub Actions secret if required |
| `WEALTH_DB_PASSWORD` | Optional database password override | GitHub Actions secret if required |
| `WEALTH_DB_POOL_SIZE` | Hikari maximum pool size | Default `5` |
| `REDIS_URL` | Redis connection URL | GitHub Actions secret |
| `WEALTH_SESSION_SECRET` | Session signing secret | GitHub Actions secret |
| `WEALTH_ACCESS_KEY` | Internal/application access key | GitHub Actions secret |

The JDBC configuration accepts either a `postgresql://` URL or an already-prefixed `jdbc:postgresql://` URL.

## 4. Vercel environment findings

The Vercel project shown in the supplied screenshot is `karthi-4a8f/wealth`.

The development Preview environment is branch-scoped to `development`. The inspected environment configuration included:

- `POSTGRES_URL`: encrypted Preview variable associated with the isolated Neon development database.
- `WEALTH_MIGRATIONS`: Preview-only setting for the development branch.
- `CRON_SECRET`: sensitive Preview variable.
- Other application integration variables.

The Neon development project was independently identified as `wealth-development` in region `aws-ap-southeast-1` (Singapore). Its development connection string was retrievable through the connected Neon integration.

The Vercel Redis store was identified as `redis-chestnut-brush`, in region `bom1` (Mumbai). Its integration credential is masked by the available Vercel integration; the Redis URL/password was not retrieved.

**Important:** No credential values are stored in this document. Do not commit database URLs, Redis URLs, passwords, session secrets, access keys, or Vercel tokens to Git.

## 5. Deployment behavior and confirmed failure

The BSS GitHub Actions workflow builds and publishes an AMD64 Docker image, then connects to the Oracle VM over SSH and replaces the `wealth-bss` container.

The BSS deployment step requires these four GitHub Actions secrets:

- `WEALTH_JDBC_URL`
- `REDIS_URL`
- `WEALTH_SESSION_SECRET`
- `WEALTH_ACCESS_KEY`

A deployment run for commit `6999d2b63455733ae2175ececd9dd12806a06274` was inspected:

- Build and tests: passed.
- Docker image build and publish: passed.
- SSH host fingerprint verification: passed.
- Oracle deployment: failed before pulling/replacing the container.
- Exact failure: `Missing WEALTH_JDBC_URL secret`.
- The job log showed all four application secrets empty in that run.

Therefore, that run did **not** update the Oracle BSS container. The failure was missing deployment secrets, not a Docker image build failure.

## 6. Current outstanding work

- [ ] Add the four required BSS GitHub Actions secrets to `wealth-bss`.
- [ ] Supply the development Neon connection as `WEALTH_JDBC_URL` (prefix with `jdbc:` if using the current JDBC configuration).
- [ ] Retrieve the Redis integration URL securely and add it as `REDIS_URL`.
- [ ] Supply the existing compatible session signing secret as `WEALTH_SESSION_SECRET`; do not generate a replacement casually because existing session cookies may depend on it.
- [ ] Supply the correct application access key as `WEALTH_ACCESS_KEY`.
- [ ] Rerun the BSS development deployment and inspect the build/deploy job results.
- [ ] Confirm runtime logs and application-to-database/Redis connectivity using approved operational checks.

GitHub Actions secrets page:  
https://github.com/akashkarthi11/wealth-bss/settings/secrets/actions

## 7. Vercel as the configuration source of truth — proposed next step

The preferred long-term design is to use the Vercel `wealth` project's branch-scoped Preview variables as the source of truth for the `development` deployment, rather than manually maintaining duplicate values.

Proposed flow:

1. Store development-only values in Vercel Preview variables scoped to Git branch `development`.
2. Authenticate a GitHub Actions job to Vercel using a protected `VERCEL_TOKEN` GitHub secret and the correct project/team identifiers.
3. Pull only the Preview variables for the `development` branch during the deployment job.
4. Transfer the required values to the Oracle Docker container as runtime environment variables.
5. Never print the pulled environment file, echo secret values, upload it as an artifact, or commit it.
6. Keep Production variables and the Production Neon database outside this development deployment path.

Vercel CLI supports pulling Preview variables for a specific Git branch with:

```bash
vercel env pull .env.preview --environment=preview --git-branch=development
```

This flow is a **proposal only**. It has not yet been implemented in the GitHub Actions workflows. The Redis integration credential still needs a secure retrieval path if it is not made available by the Vercel environment pull operation.

## 8. Safety boundaries

- All code and workflow changes described here target the `development` branches.
- Do not deploy the development profile with Production database credentials.
- Do not modify the Production database as part of this migration.
- Do not place secrets in `application.yml`, Dockerfiles, source code, logs, or documentation.
- Do not remove the currently deployed container until required configuration is validated and the deployment can proceed.
- Keep BFF and BSS as separate Docker containers.
