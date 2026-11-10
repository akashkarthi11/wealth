# Authentication hardening — owner-only reset, password policy, rate limits, revocable sessions

- **Date:** 2026-11-10
- **Primary module:** Auth
- **Status:** Code committed on `claude-dev` (`e6b0fd3`); tests pass; migration 0001 not yet applied to any database; not deployed
- **TSD:** [Claude Plan 1](../../plans/claude-plan-1.md) Phase 1 (TR-1.1 – TR-1.5), defects DEF-01, DEF-02

## Symptoms

- Anyone holding the shared access key could reset any account's password, including the owner's (`action=forgot`).
- The server accepted empty passwords; there was no login rate limit; a password reset did not end existing sessions; the access key was compared with `===`.

## Root cause

`api/auth.js` treated the access key as proof of identity for resets, enforced no password policy, and session cookies were stateless with no version to revoke.

## Resolution

| Change | Files |
|---|---|
| Reset is owner-only: a signed-in admin calls `action=reset` (the old `forgot` name is accepted but needs the same admin session). Anonymous attempts get 403 with guidance. Recovery for a locked-out owner: `scripts/admin/reset-password.mjs` | `api/auth.js`, `scripts/admin/reset-password.mjs`, `app.js` |
| 10–200 character passwords on register and reset (login checks only the maximum so older passwords keep working) | `api/_lib.js`, `api/auth.js` |
| 5 failed logins per email and 20 per IP per 15 min; register/reset share the IP limit; returns 429 + `Retry-After`; fails open if Redis is down | `api/_lib.js`, `api/auth.js` |
| `wealth_users.session_version`; cookies carry `sv`; every API handler uses `sessionUser()`, which rejects older versions; reset bumps the version | `scripts/migrations/0001_session_version.sql`, all `api/*.js` |
| Constant-time access-key comparison | `api/_lib.js` |
| UI: "Forgot password?" explains the owner resets passwords; owner gets "Reset a password" in More | `app.js` |

Until migration 0001 is applied, `sessionUser()` falls back to signature-only checks so a code deploy cannot lock anyone out.

## Verification

- [x] `scripts/tests/auth.test.mjs`: password policy, constant-time compare, token with session version, legacy tokens, tampering, rate limiter fail-open.
- [ ] Apply 0001 on a Neon branch, then Development (approval).
- [ ] Manual check after deploy: wrong password 6× → 429; reset signs out other sessions.

## Deployment

Not deployed. Requires explicit approval per environment.

## Regression — 2026-11-10: login failed on the dev team's Preview of `claude-dev`

**Observed:** login on the Preview deployment built by the `development-b9bc/wealth` Vercel team failed; Vercel's runtime logs showed no useful error. (Not a "D1 database binding" problem: D1 in this repo means TSD decision D1; the stack is Vercel + Neon.)

**Root causes (reproduced locally):**
1. Login now calls Redis for rate limiting. With `REDIS_URL` pointing at an unreachable host, the Redis client retried forever and the call never returned — still waiting after 12 s, past Vercel's 10 s function limit. A timeout leaves no error in the logs.
2. With an invalid `REDIS_URL` (for example a `[SENSITIVE]` placeholder copied from a pulled env file), `createClient` threw while the module loaded, so every API route failed — login included.

**Fix (`api/_lib.js`):** the Redis client is created lazily inside a guarded path; every operation has a 1 s limit (`REDIS_OP_TIMEOUT_MS`); a failed connection does not retry; after any failure Redis is skipped for 30 s. Rate limiting and caching fail open, so login works without Redis.

**Verified:** `scripts/tests/redis-failopen.test.mjs` — unreachable Redis returns in ~1 s and then instantly; an invalid URL no longer crashes the module.

**Still to check in the `development-b9bc` Vercel team (not accessible from this machine's CLI login):** its Preview environment variables must hold real values — `WEALTH_SESSION_SECRET` (≥ 32 characters; otherwise login returns 500), `WEALTH_ACCESS_KEY`, a database URL, and either a valid `REDIS_URL` or none. Values copied from a pulled `.env` file may be `[SENSITIVE]` placeholders.
