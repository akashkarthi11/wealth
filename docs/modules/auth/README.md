# Auth & security module

Accounts, sessions, roles and access control.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/auth.js`](../../../api/_routes/auth.js) | `GET` current user; `POST ?action=login|register|forgot|logout` |
| [`api/_routes/clear-session.js`](../../../api/_routes/clear-session.js) | `GET` clears the session cookie and redirects to `/` |
| [`api/_lib.js`](../../../api/_lib.js) | `hash`/`check` (scrypt), `token`/`userFrom` (HMAC session), `cookie` |

## Design

- Passwords: scrypt with 16-byte salt, stored as `s1$<salt>$<hash>`; constant-time compare.
- Session: `wealth_session` cookie = base64url `{uid, exp}` + HMAC-SHA256 signature using `WEALTH_SESSION_SECRET` (≥ 32 chars). `HttpOnly; Secure; SameSite=Lax`, 7 days.
- Register and forgot-password require the shared `WEALTH_ACCESS_KEY`.
- Roles: `wealth_users.role`; `admin` unlocks snapshots, Angel One, providers, and the source navigation.

## Known issues (security)

- **Account takeover:** `forgot` resets any account's password given only the email and the shared access key — no email/token verification ([`api/_routes/auth.js:32-36`](../../../api/_routes/auth.js#L32-L36)).
- No server-side minimum password length; an empty password is accepted (UI says 10+).
- No login rate limiting or lockout.
- Sessions cannot be revoked before expiry (stateless tokens; password reset does not invalidate them).
- Access key compared with `===` rather than a constant-time compare.
