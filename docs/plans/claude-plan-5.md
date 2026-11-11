# Technical Specification Document (TSD) — Claude Plan 5

**Wealth Ledger — Statement Upload & Import, and More Than One User**

## 0. Document control

| Field | Value |
|---|---|
| Document | TSD — Claude Plan 5 |
| Project | Wealth Ledger (`akashkarthi11/wealth`), Vercel project `wealth` |
| Version | 0.1 (draft) |
| Date | 2026-11-11 |
| Author | Claude (Claude Code), prepared for the project owner |
| Status | **Draft** — not started; waiting for owner decisions D1–D2 (§10) |
| Predecessor | [Claude Plan 4](claude-plan-4.md) (Parts 0, A, B in Production; `main` `7407c9f`, build `4h`, migrations through 0021) |
| Owner request | "now if new user come how can he share data is there any option to upload statement directly to website there find data and put in db" · "this is plan add to plan" |
| Standing rules | [rules.md](../../rules.md): transactions go to `wealth_transactions` only; balances are never changed by an import; never `pending_reconciliation`; interest is written only by the nightly job (§2a). **No data is deleted.** Production only for routine operations; Development for rehearsal. Every deployment and production write needs explicit owner approval. `v2` is never merged into |

### Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-11-11 | First draft: statement upload & import (Part A), more than one user (Part B) |

---

## 1. Introduction

### 1.1 Purpose
Let a signed-in person upload a bank / card / broker statement on the website, see the transactions found in it, correct
them, and import them into their own ledger — instead of sending the file to Claude or ChatGPT. Then make the app safe
and useful for a second person (family member or someone separate).

### 1.2 Scope
- **Part A — Statement upload & import** (the owner's own account first).
- **Part B — More than one user**: every page and API works per user; one user can never see another user's data.

### 1.3 Out of scope
- Live bank connections (Account Aggregator / screen scraping).
- Storing the statement file itself, or any personal details in it (PAN, name, address, phone).
- Changing balances from a statement (rules.md §1–2): balances keep coming from screenshots / owner entries.

---

## 2. Current state (2026-11-11)

| How data gets in today | Who | Limits |
|---|---|---|
| Owner sends a statement to Claude; Claude reads it and imports after approval (e.g. HDFC ••9498, 638 rows) | Claude | Needs a chat session every time |
| ChatGPT hourly task reads bank e-mails in Gmail (`wealth_email_imports`) | ChatGPT | Only what arrives by e-mail; owner's account only |
| Typing an entry in the app (New ledger entry) | Owner | One row at a time |

- **No upload on the website.** Statement formats already handled by hand: HDFC savings (PDF, password), Slice (savings / card), Paytm (UPI history, XLSX), Angel One (ledger, P&L).
- **Users:** sign-up needs the owner's secret key and creates role `user`. Most write APIs answer **"Owner only"** (`authorize` → admin). Background work is tied to the owner (`ownerId()`): nightly interest, ChatGPT tasks, price refresh. Rows are stored with `user_id`, so data is already separated per user in the tables — the app around it is single-owner.

---

## 3. Target design

```
 Browser (file never leaves the device)                         Server (owner or signed-in user)
 ┌──────────────────────────────────────────┐                   ┌───────────────────────────────────────────┐
 │ pick PDF / XLSX / CSV  (+ PDF password)   │                   │ POST /api/imports/preview  rows → checks   │
 │ read text / cells (pdf.js / SheetJS)      │ ── rows only ──►  │   duplicates, self transfers, interest,     │
 │ detect format → parser → rows             │                   │   people, account match, categories         │
 │ preview table: fix kind / category / acct │ ◄── verdicts ──   │ POST /api/imports  confirmed rows →         │
 │ tap Import                                │ ── confirmed ──►  │   wealth_transactions (external_ref)        │
 └──────────────────────────────────────────┘                   │   + wealth_import_batches (summary, undo)   │
                                                                 └───────────────────────────────────────────┘
```

Principles: the file is read **in the browser**; only transaction rows (date, amount, direction, description,
reference) are sent. Nothing is saved until the person taps **Import**. Every imported row carries a stable
`external_ref`, so the same statement can be uploaded again without duplicates.

---

## 4. Part A — Statement upload & import

| ID | Requirement |
|---|---|
| TR5-A.1 | **Import page** (Activity menu → "Import statement"): pick a file (PDF, XLSX, CSV; up to 10 MB); password box for protected PDFs (used in the browser only, never sent or stored) |
| TR5-A.2 | **Read in the browser**: PDF text with pdf.js, XLSX/CSV with SheetJS (pinned versions from cdnjs). The file is not uploaded |
| TR5-A.3 | **Format detection + parsers** (one small module per format, each with sample-based tests): HDFC savings PDF, Slice savings / credit card, Paytm UPI history XLSX, Angel One ledger; **generic CSV** where the person maps the columns (date, description, debit, credit / amount + sign, reference) once and the mapping is remembered |
| TR5-A.4 | **Row shape** sent to the server: `date, amount (> 0), direction (in/out), description, reference (UPI / cheque / txn id), balance_after (optional, for checking only)` — no names of the account holder, no PAN / address |
| TR5-A.5 | **Account**: the person picks which of their accounts the statement belongs to (pre-selected when the statement's masked number matches, e.g. ••9498) |
| TR5-A.6 | **Preview checks** (`POST /api/imports/preview`, no writes): duplicate (same reference, or same account + date + amount + direction), already imported by e-mail, **self transfer** between the person's own accounts → `transfer` "Self transfer", **interest** line → skipped (rules.md §2a), card bill payment → `liability` / transfer pair, money to / from a person → `transfer` with a People suggestion, running / month-to-date totals → skipped |
| TR5-A.7 | **Preview table**: one row per transaction with the suggested kind, category and verdict (new · duplicate · skipped: interest · self transfer); the person can change kind / category / skip before importing; totals in / out and the statement's opening → closing balance check when the statement has balances |
| TR5-A.8 | **Import** (`POST /api/imports`): only confirmed rows go to `wealth_transactions` with `external_ref = 'stmt:<account>:<reference or date|amount|direction|n>'` (idempotent, `ON CONFLICT DO NOTHING`); one `wealth_import_batches` row (file name, format, account, period, counts, user); actor = the signed-in person |
| TR5-A.9 | **Never** touches balances, holdings, interest or rewards (rules.md). After import, a "balance mismatch" note appears if the statement's closing balance differs from the recorded balance — the person records the balance separately |
| TR5-A.10 | **Undo a batch**: marks its rows as duplicates of nothing (`import_batch_id` + status `reverted`), so they stop counting — no delete (rules: no data is deleted) |
| TR5-A.11 | **People / splits hook**: transfers to a person in the imported rows show the one-tap "Lent to …" from Plan 4 |
| TR5-A.12 | Limits: up to 5,000 rows per import; request body under 4 MB (Vercel); rate limit per user |

## 5. Part B — More than one user

| ID | Requirement |
|---|---|
| TR5-B.1 | **Decide the model (D1)**: (a) *separate people* — each user sees only their own data; or (b) *family / household* — a household shares some accounts with roles (owner, member, viewer) |
| TR5-B.2 | **Every API scoped by the caller**: replace owner-only checks (`authorize` → admin) with "signed-in user, own `user_id`" for personal data; keep admin-only for app settings, backups, other users' passwords |
| TR5-B.3 | **Isolation tests**: for every route, a second user gets 404 / empty for the first user's ids (accounts, transactions, splits, people, rewards, splits, imports) |
| TR5-B.4 | **Background jobs per user**: nightly interest, price refresh (shared prices, per-user holdings), data checks — loop over users instead of `ownerId()` |
| TR5-B.5 | **Agents (ChatGPT / Gmail)** stay on the owner's account unless a user connects their own mail (later) |
| TR5-B.6 | **Sign-up**: invite link from the owner (one-time code) instead of sharing the secret key; new user starts empty and is guided to "Add accounts" → "Import statement" |
| TR5-B.7 | **Empty-state onboarding**: first-run checklist — add accounts, import a statement, record balances |
| TR5-B.8 | Optional (D1 = household): `wealth_households`, `wealth_household_members`, account sharing flag; shared totals only for shared accounts |

---

## 6. Data design (migration 0022+, additive only)
- `wealth_import_batches` (id, user_id, account_id, file_name, format, period_from, period_to, rows_found, rows_imported, rows_skipped, status `imported` / `reverted`, created_at).
- `wealth_transactions.import_batch_id` (nullable FK) — which upload a row came from.
- `wealth_import_mappings` (user_id, format key, column mapping JSON) — remembered generic-CSV mappings.
- Part B (if D1 = household): `wealth_households`, `wealth_household_members (role)`, `wealth_accounts.household_id`.
- Audit and data-version triggers on every new table.

## 7. API (OpenAPI 3.x outline)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/imports/preview` | signed-in user | rows + account → verdicts (duplicate, self transfer, interest, person), suggested kind / category; no writes |
| POST | `/api/imports` | signed-in user | confirmed rows → transactions; returns batch id and counts (`?dryRun=1`) |
| GET | `/api/imports` | signed-in user | past batches with counts |
| POST | `/api/imports/revert` | signed-in user | stop counting a batch's rows (no delete) |
| GET / PUT | `/api/imports/mappings` | signed-in user | remembered CSV column mappings |
| POST | `/api/users/invite` | owner | one-time invite link (Part B) |

Validation: dates not in the future; amounts > 0; account must belong to the caller; 400 / 401 / 403 / 409 as in Plan 3 §7.

## 8. Testing
- Parser tests with **redacted sample statements** (no real names / numbers) for each format, plus a generic-CSV mapping test.
- Preview checks: duplicates (by reference and by date+amount), self transfer pairing, interest skipped, person suggestion.
- Import idempotency (same file twice → 0 new rows), revert, no balance writes (row counts of balance tables unchanged).
- Part B: cross-user isolation test for every route; jobs run per user.
- UI: page markup tests (same sandbox pattern as `loans.test.mjs`), headless screenshots at phone width.

## 9. Rollout
Part A for the owner first → Development rehearsal → owner approval → `development` → `main`. Part B only after D1, with
the isolation tests green, then invite one test user on Development before Production.

## 10. Decisions needed (owner)
| ID | Question | Options |
|---|---|---|
| D1 | Who is the new user? | separate person (sees only own data) · family / household (shares some accounts) |
| D2 | Which statements first? | HDFC savings PDF · Slice savings / card · Paytm UPI XLSX · Angel One ledger · others (name them) |
| D3 | Generic CSV import for any bank? | yes (map columns once) · later |
| D4 | Undo a whole import batch? | yes (rows stop counting, kept as history) · no |

## 11. Risks
| Risk | Mitigation |
|---|---|
| Statement formats change | One parser per format with sample tests; unknown layout falls back to generic CSV / "send to Claude" |
| Wrong kind (spend vs transfer) | Preview with verdicts and edits before anything is saved; self-transfer and person checks |
| Duplicates with e-mail / earlier imports | Stable `external_ref`, date+amount+direction match, preview shows "already in" |
| Personal data in statements | File read in the browser only; only transaction rows sent; no PAN / address stored |
| A second user sees the owner's data | Part B ships only with per-route isolation tests; owner-only stays the default until then |
| Large files on Vercel Hobby | Parse in the browser; send rows in chunks under 4 MB |

## 12. Delivery estimate
| Part | Size |
|---|---|
| A | Medium — import page, 4 parsers + generic CSV, preview/import APIs, batch table, tests |
| B | Large — every route and job made per-user, isolation tests, invites, onboarding (household adds more) |
