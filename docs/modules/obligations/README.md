# Obligations module (bills, mandates, alerts)

Planned bills, bank mandates/subscriptions, recurring commitments and the payment-alerts view.

## Files

| File | Responsibility |
|---|---|
| [`api/_routes/planned-bills.js`](../../../api/_routes/planned-bills.js) | `GET` planned bills + active subscriptions + active commitments; `PATCH` bill status (`paid`/`cancelled`/`planned`) |
| [`app.js`](../../../app.js) | `alertPaymentItems`, `alertsHtml`, `alertsBannerHtml`, `plannedBillsHtml`, `subscriptionsHtml` |
| [`scripts/migrations/legacy/2026-11-10-recurring-obligations.sql`](../../../scripts/migrations/legacy/2026-11-10-recurring-obligations.sql) | Unified obligations + payment occurrences (additive) |
| [`scripts/migrations/legacy/2026-11-10-reconcile-mandate-bill-duplicates.sql`](../../../scripts/migrations/legacy/2026-11-10-reconcile-mandate-bill-duplicates.sql) | Cancels planned bills duplicated by an active mandate |

## Tables

- `wealth_planned_bills` — one-off/recurring reminders (`bill_key`, `due_date`, `status`).
- `wealth_subscriptions` — bank mandates (`provider_key`, `mandate_key`, `amount_type`, `frequency`, `next_due_date`, `obligation_id`).
- `wealth_recurring_obligations` — unified model; `source_type` ∈ `planned_bill`/`subscription`/`manual`.
- `wealth_payment_occurrences` — one row per obligation per due date.

## Rules

- Alerts include anything due within 5 days or overdue.
- Alerts are de-duplicated by normalized name (stop-words like "policy", "premium", "mandate" removed) + due date.
- A bill is a duplicate of a mandate when user, amount, account and due date match and `bill_key` equals or starts with `provider_key + '_'`. The bill is cancelled; the mandate is canonical.
- Planned bills and mandates are reminders, never counted as spending.

## Known issues

- `PATCH /api/planned-bills` does not update the matching `wealth_recurring_obligations` / `wealth_payment_occurrences` rows.
