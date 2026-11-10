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
