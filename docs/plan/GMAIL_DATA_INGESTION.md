# Wealth — Gmail Data Ingestion & Document Vault

**Status:** Proposed design  
**Priority:** Mandatory foundation before Wealth intelligence features  
**Current permission:** Documentation and read-only discovery only  
**Gmail access model:** Read-only  
**Financial write model:** Stage, reconcile, deduplicate, then owner-confirm

## 1. Objective

Use Gmail as a primary discovery channel for financial information entering Wealth. The system should identify relevant notifications and documents, extract structured facts, preserve source evidence, and prepare safe imports.

Gmail is a source channel, not the financial system of record. An email or attachment is evidence to evaluate; it must not automatically become a trusted balance or ledger entry.

## 2. Discovery scope

Search financial-relevant messages across Inbox and archived mail, including historical periods and new incoming messages.

### Email categories

- Bank credits, debits, UPI, IMPS, NEFT, RTGS, cash deposits and withdrawals.
- Card purchases, card payments, refunds, reversals, fees and bill reminders.
- Auto-debits and mandates: NACH, EMI, loan repayment, SIP, insurance, subscriptions and standing instructions.
- Salary, reimbursements, rent receipts and other income.
- Bills, invoices, receipts and payment confirmations.
- Broker trades, contract notes, funds added/withdrawn, ledger statements, margin statements, holdings and charges.
- Demat/depository alerts, CDSL/NSDL statements, corporate actions and dividends.
- Mutual-fund transactions, portfolio statements, capital gains and registrar statements.
- Fixed deposits, recurring deposits, loan statements and liability schedules.
- Tax-related financial documents and other records that materially affect net worth or cash flow.

Do not ingest unrelated personal mail. Spam, Trash and Drafts are excluded by default. Sent messages may be searched only when they contain relevant financial evidence or owner-provided documents.

## 3. Attachment and document discovery

Recognise and catalogue:
- Bank account statements.
- Credit-card statements.
- Broker funds/securities, ledger, contract-note and margin statements.
- Demat and consolidated account statements.
- Mutual-fund statements and transaction confirmations.
- Loan, EMI, insurance and deposit documents.
- Bills, invoices, receipts and payment proofs.
- Tax and investment certificates.

Support PDF, CSV, XLS/XLSX and other formats only after a safe parser is selected. Scanned or malformed documents should be marked for OCR/manual review, not silently skipped.

## 4. Recommended ingestion pipeline

1. **Discover:** search Gmail using sender/domain patterns, financial keywords, date windows and attachment metadata.
2. **Classify:** identify institution, source account where safely available, message type, document type, period and likely financial categories.
3. **Preserve provenance:** record Gmail message/thread identifiers, sender, received timestamp, subject, attachment filename, MIME type, size and cryptographic file hash.
4. **Archive source:** retain the original attachment in private, access-controlled storage according to a documented retention policy. Do not modify, delete, label, move or archive Gmail messages.
5. **Unlock:** resolve a document password through the password vault or request it from the owner.
6. **Extract:** parse transactions, balances, holdings, statement periods, fees, auto-debits and other supported fields.
7. **Normalise:** map extracted facts to Wealth's existing domain model without creating a parallel ledger.
8. **Stage:** store candidate records in a review/import staging area, linked to their source evidence.
9. **Deduplicate:** compare stable external references first, then institution/account, date, amount, currency, direction, description and other available evidence.
10. **Reconcile:** compare notification emails with statements and identify missing, duplicated, reversed or conflicting entries.
11. **Review:** show the owner source evidence, parsed values, confidence and warnings.
12. **Commit:** only after explicit owner confirmation, use the approved existing transaction workflow and verify the result.

## 5. Notification vs statement precedence

Use both sources because they serve different purposes:

- Transaction notifications are timely evidence that an event may have occurred.
- Official statements are periodic evidence for completeness and reconciliation.
- A notification and the same transaction on a statement represent one financial event, not two transactions.
- Statement opening/closing balances must be retained as statement evidence and compared with account balance records; do not silently overwrite balances.
- Reversals, refunds, chargebacks and failed transactions must be represented distinctly and linked to the original event where possible.
- A missing notification does not invalidate a statement transaction.
- Conflicting amounts/dates/accounts must be flagged for review.

## 6. Document password vault

### 6.1 Lookup key

The intended password lookup scope is:
- Owner/user scope.
- Verified sender or institution identity (prefer a validated domain plus institution mapping, not display name alone).
- Document type (for example, bank statement, credit-card statement, broker contract note or demat statement).
- Optional institution/account discriminator when one sender issues different password conventions for different accounts.

A password should not be assumed to work for every document from the same organisation. Document type and any account-specific rule must be part of matching.

### 6.2 Processing behaviour

1. Identify the sender/institution and document type.
2. Look for an active matching encrypted credential.
3. Attempt to open the document without exposing the password in logs or user-visible diagnostics.
4. If no credential exists, the password fails, or the document format indicates a changed password, pause extraction and request the password from the owner in an authenticated Wealth interface.
5. Validate the supplied password against the specific document.
6. If successful, store the credential encrypted for future documents matching the approved lookup scope.
7. Continue extraction and staging.
8. If validation fails, do not overwrite a previously working credential automatically. Ask for correction and preserve a safe failure status.

### 6.3 Storage and security requirements

- Never store plaintext document passwords.
- Store authenticated ciphertext only, using authenticated encryption such as AES-256-GCM or an approved equivalent.
- Keep encryption keys outside PostgreSQL, preferably in a managed secret/KMS facility. If an application secret is used initially, it must be separate from the database and access-controlled.
- Include key versioning and a rotation/re-encryption plan.
- Restrict vault reads to the document-processing service; never expose decrypted passwords through normal API responses.
- Do not log passwords, decrypted document content beyond approved redacted diagnostics, or secret-bearing exception details.
- Do not send passwords or raw protected documents to AI providers.
- Do not put passwords in Gmail, Git, source code, environment-visible client bundles, analytics, or ordinary audit events.
- Backups must preserve ciphertext only and must not contain the encryption key alongside the database backup.
- Audit credential creation, update, use and failure without recording the secret itself.
- Provide an owner-controlled way to replace or revoke a saved credential.

### 6.4 Proposed logical record

This is a conceptual design, not an approved schema or migration:

| Field | Purpose |
|---|---|
| owner_id | Owner/security boundary |
| institution_key | Verified institution identity |
| sender_domain | Sender-domain evidence |
| document_type | Password matching scope |
| account_hint | Optional non-secret discriminator |
| encrypted_password | Authenticated ciphertext |
| encryption_key_version | Key rotation support |
| status | Active, needs_update, revoked |
| created_at / updated_at | Credential lifecycle |
| last_success_at | Last successful document unlock |
| last_failure_at | Last failed attempt, if useful |

The exact table name, columns, constraints and relationship must be checked against the previously discussed password-table design and current schema before any implementation. Do not create a duplicate password table.

## 7. Data model and archive boundaries

Keep separate concepts separate:

- **Source message/document metadata:** what arrived and where it came from.
- **Private original-document archive:** immutable source evidence with access controls and retention.
- **Extraction result:** parsed content, parser version, confidence and warnings.
- **Staging/review records:** candidate financial events awaiting confirmation.
- **Canonical Wealth records:** existing transactions, accounts, balances, investments and liabilities.

Do not use the password vault as a general document store. Do not use the transaction ledger to store raw email bodies or parsed-but-unconfirmed candidates.

## 8. Financial integrity rules

- Transaction imports write to `wealth_transactions` only.
- Do not change account or balance tables as a side effect of transaction insertion.
- Check external references and existing transactions before inserting.
- Never claim a balance is verified without direct statement/bank evidence.
- Preserve source statement period and evidence timestamp.
- Do not use `pending_reconciliation`.
- Interest is written only by the application's authorised nightly job. Do not import running/monthly interest totals or create duplicate interest entries.
- Do not auto-import ambiguous rows, duplicate statements, or unsupported transactions.
- Do not let an LLM determine authoritative amounts, balances or transaction identity.

## 9. Gmail permissions and mailbox safety

- Request the narrowest Gmail read-only permission that supports the approved workflow.
- Do not send, reply, label, move, archive, trash or delete messages.
- Keep Gmail tokens server-side and out of logs/client code.
- Provide a disconnect/revoke path and a visible last-scan status.
- Handle API quotas, pagination, attachment-size limits, retries and partial failures.
- Store message IDs and attachment hashes so repeated scans are idempotent.
- Respect provider terms, privacy expectations and account security.

## 10. Review interface requirements

For each staged import, show:
- Institution and account label (masked where appropriate).
- Source email date, sender and subject.
- Attachment name and statement period.
- Extracted transaction date, amount, direction, description, category and reference.
- Confidence and parser warnings.
- Duplicate/reversal/mismatch indicators.
- Whether the value came from a notification or official statement.
- Proposed action: accept, reject, or mark for manual review.

Bulk approval should be limited to rows with clear provenance and validated duplicate checks. Ambiguous rows require individual review.

## 11. Operational monitoring

Track:
- Last successful Gmail scan and scan range.
- Messages searched and relevant messages found.
- Documents discovered, archived, parsed and failed.
- Password prompts and unlock success/failure counts (never password values).
- Duplicate candidates and reconciliation mismatches.
- Staging queue age and owner review backlog.
- Gmail quota/permission failures and parser version.

## 12. Acceptance criteria

- Historical financial email discovery covers Inbox and archived mail for the agreed date range.
- New financial emails are discoverable without mailbox mutation.
- Each extracted record traces to a source message and document.
- Supported notification and statement types are classified correctly in a representative test set.
- Repeated scans do not create duplicate staged documents or financial transactions.
- Password-protected PDFs can be unlocked using a matching encrypted credential.
- A new/changed password triggers an authenticated owner prompt and is saved only after validation.
- No plaintext password appears in database rows, logs, API responses, AI prompts or client bundles.
- Statement-vs-notification duplicates and conflicts are surfaced.
- No unconfirmed candidate is written to the canonical ledger.
- Interest and balance rules remain intact.

## 13. Open design checks before implementation

- Inspect the exact password table/schema previously discussed; do not create a second one.
- Confirm the approved key-management mechanism and recovery/rotation process.
- Confirm Gmail OAuth scopes and historical scan boundaries.
- Confirm private document archive provider, retention and backup policy.
- Inventory actual sender domains, statement formats and password conventions from a representative sample.
- Determine whether any institution uses account-specific password patterns.
- Verify parser libraries, OCR requirements, file-size limits and free-tier cost.
- Define owner confirmation and reprocessing behaviour for corrected passwords.

## 14. Current boundary

This document authorises planning only. It does not authorise Gmail OAuth changes, mailbox modifications, password collection, database schema changes, document uploads, transaction imports, code changes or deployment. Each requires a separately approved implementation scope.
