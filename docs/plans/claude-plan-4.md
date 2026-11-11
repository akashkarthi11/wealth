# Technical Specification Document (TSD) — Claude Plan 4

**Wealth Ledger — Rewards & Points, Money Lent, and Voucher Advisor**

## 0. Document control

| Field | Value |
|---|---|
| Document | TSD — Claude Plan 4 |
| Project | Wealth Ledger (`akashkarthi11/wealth`), Vercel project `wealth` |
| Version | 0.1 (draft) |
| Date | 2026-11-11 |
| Author | Claude (Claude Code), prepared for the project owner |
| Status | **Draft — waiting for owner decisions (§12)**. Nothing built yet |
| Predecessor | [Claude Plan 3](claude-plan-3.md) v1.3 (deployed, `main` `f27100f`) |
| Owner request | "next plan points include cb, cc point, slice monies, coin point in gold, slice spark, roarbank reward, hdfc cc reward · 2 - lending amount · 3 - where i need to buy voucher" |
| Standing rules | [rules.md](../../rules.md): transactions go to `wealth_transactions` only; balances only with evidence; never `pending_reconciliation`. **No data is deleted.** Production only for routine operations; Development for rehearsal. Every deployment and production write needs explicit owner approval. `v2` is never merged into |

### Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-11-11 | First draft: rewards & points (Part A), money lent (Part B), voucher advisor (Part C), balance-write guard (Part 0) |

---

## 1. Introduction

### 1.1 Purpose
Track the value that sits **outside** bank and investment balances — reward points, coins, cashback and money lent to people — and use the card and voucher reward rules to answer "where should I buy this voucher / pay for this?".

### 1.2 Scope
| Part | What | Why |
|---|---|---|
| 0 | Guard against balance writes that break the totals | An external writer changed Slice Savings twice on 11 Nov (§2.3) |
| A | Rewards & points: cashback, credit-card points, Slice Monies, Slice Spark, Paytm Gold Coins, Roarbank rewards, HDFC Swiggy card rewards | Today they are scattered in screenshots and notes; none has a balance, value or expiry in the app |
| B | Money lent: to people, and P2P lending (NDX P2P) | Transfers to people are all "Transfer sent"; nothing says which are loans or what is still owed |
| C | Voucher / payment advisor | Pick the card, app or voucher platform that returns the most for a planned purchase |

### 1.3 Out of scope
Placing orders or buying vouchers; scraping bank or card apps; changing card limits; crypto holdings (separate decision, Plan 3 §14.6).

---

## 2. Current state (Production, 2026-11-11)

### 2.1 Rewards already in the data
| Program | What we have | Where |
|---|---|---|
| Paytm Gold Coins | **436 coins = ₹4.36 of gold**, redeemable at 500 coins (9 Nov). Kept apart from the 2 g gold holding | Records: "Paytm gold, silver and reward coin clarification" |
| Slice Monies | **1,30,954 Monies** displayed (7 Nov); ledger note says "exclude — not an asset". ₹ value per Monie not recorded | Records: 7 Nov ledger; "Slice, Atom balances … Monies rewards" (9 Nov) |
| Slice Spark | Not in the data yet | — |
| Roarbank rewards | Not in the data yet (Roarbank savings ₹650.65 and credit card are) | Records: "Credit card and Roarbank screenshots" |
| HDFC Swiggy Orange ••9229 | Card account exists; reward / cashback balance not recorded | `wealth_accounts` |
| Cashback received (transactions) | Credit card cashback 24 rows ₹2,665.85 · Cashback 19 rows ₹732.70 · Reward credit 1 row ₹300 | `wealth_transactions` (`income`) |

### 2.2 Lending already in the data
- No loan records. People payments are `transfer` / "Transfer sent" or "Transfer received" (HDFC 2025-26: Subramanian P ₹1,40,000 sent; Arun S ₹17,300; Murali Muthu ₹15,000; Anantha Raj Maria ₹12,000 sent / ₹7,000 back; Dinoraj P ₹5,000 sent / ₹5,000 back; Paytm 2023-24 similar).
- P2P: ₹15,000 to "NDX P2P Pvt Ltd" on 20 Nov 2023 (likely LiquiLoans), status unknown.
- Monthly ₹21,600 to HDFC A/c ••7649 (looks like an EMI paid on someone's behalf), not modelled.

### 2.3 Balance-write incident (drives Part 0)
| Time (IST) | Writer | Change |
|---|---|---|
| 13:40 | external (ChatGPT) | added ₹5,000 "UPI transfer to Arun S"; set Slice Savings ₹42,889.22, `pending_reconciliation` → account left the totals |
| 13:49:29 | owner (repair) | status → `stale`; history row → `estimated` |
| 13:49:38 | external | set the account back to **₹47,889.22 as of 10 Nov** (likely undoing its own deduction per rules.md) |

Result: `wealth_accounts` says ₹47,889.22 while the newest `wealth_account_balances` row says ₹42,889.22 — v1 (dashboard) and v2 disagree by ₹5,000 until the owner confirms the real balance (decision D0).

---

## 3. Target design

```
 Screenshots / statements / Gmail ──► ingest APIs ──► reward_balances (points + ₹ value, evidence)
                                                    ├► reward_events  (earned / redeemed / expired, linked to transactions)
 Transfers to people ──► "mark as loan" ──────────► loans + loan_payments (linked transactions)
 Reward rules (per card / app / voucher site, with source + date) ──► Voucher advisor (best option for a purchase)
                                     ▼
            Rewards page · Lending page · Advisor card · dashboard "Other value" line (not net worth unless D2 says so)
```

Principles: every balance has evidence and a date; values in ₹ use a stated conversion with its source; nothing is invented; rewards and loans are shown **separately** from net worth unless the owner decides otherwise.

---

## 4. Phases and requirements

### Part 0 — Balance-write guard
| ID | Requirement |
|---|---|
| TR4-0.1 | Reject `balance_status = 'pending_reconciliation'` on `wealth_accounts` and `status = 'pending_reconciliation'` on `wealth_account_balances` when `wealth.actor` is `external` (trigger; owner and app unaffected) |
| TR4-0.2 | Data-quality check: flag an account whose `current_balance` differs from its newest `wealth_account_balances` row |
| TR4-0.3 | Repair the Slice Savings mismatch once the owner confirms the balance (D0) |

### Part A — Rewards & points
| ID | Requirement |
|---|---|
| TR4-A.1 | `wealth_reward_programs`: one row per program — provider, name, unit ("Monies", "Gold Coins", "points", "₹ cashback"), linked `account_id` (card or bank, optional), ₹ per unit + source + as-of, minimum redemption, expiry rule, redemption options (text) |
| TR4-A.2 | `wealth_reward_balances`: program, as-of, units, ₹ value (units × rate at that time), status `verified` (screenshot/statement) or `estimated`, evidence note. Append-only; newest row is current |
| TR4-A.3 | `wealth_reward_events`: earned / redeemed / expired / adjusted, units, ₹ value, date, optional `transaction_id` (e.g. a cashback credit), evidence |
| TR4-A.4 | Cashback that arrives as money stays an `income` transaction (category Cashback / Credit card cashback); the Rewards page reads it from transactions — never stored twice |
| TR4-A.5 | Seed programs: Paytm Gold Coins (436, ₹0.01/coin, min 500), Slice Monies (1,30,954; rate per D3), Slice Spark, Roarbank rewards, HDFC Swiggy Orange rewards, Slice card cashback |
| TR4-A.6 | `POST /api/rewards/balances` (owner session or `WEALTH_INGEST_SECRET`, `?dryRun=1`) for screenshot / agent updates; `GET /api/rewards` for the page |
| TR4-A.7 | **Rewards page** (Money menu): total reward value; one card per program — units, ₹ value, progress to redemption (e.g. 436 / 500 coins), expiry warning, last update; cashback earned this month / year / all time from transactions |
| TR4-A.8 | Alert when a program is within 10 % of a redemption threshold or 30 days of expiry |

### Part B — Money lent
| ID | Requirement |
|---|---|
| TR4-B.1 | `wealth_loans_given`: counterparty (display name only), type `personal` or `p2p_platform`, principal, lent on, due date (optional), interest rate (optional), status `open` / `closed` / `written_off`, note |
| TR4-B.2 | `wealth_loan_payments`: loan, direction `out` (lent) or `in` (repaid), amount, date, linked `transaction_id` — the money movement stays a `transfer` transaction, so totals never change |
| TR4-B.3 | Outstanding = lent − repaid (+ interest when a rate is set); overdue when past the due date |
| TR4-B.4 | Activity: "Mark as loan" on a Transfer sent; "Mark as repayment" on a Transfer received (pick the loan) |
| TR4-B.5 | Suggestions: people with sent and received transfers (e.g. Dinoraj P ₹5,000 / ₹5,000, Anantha Raj Maria ₹12,000 / ₹7,000) are offered for review — never auto-created |
| TR4-B.6 | **Lending page** (Money menu): total outstanding, per-person cards (lent, repaid, outstanding, last movement, overdue), P2P platforms section (NDX P2P) |
| TR4-B.7 | Net worth: outstanding loans shown as "Receivables" — counted only if D2 says so |

### Part C — Voucher / payment advisor
| ID | Requirement |
|---|---|
| TR4-C.1 | `wealth_reward_rules`: program or channel (card, app, voucher site), merchant or category, rate (% or points per ₹), monthly cap, minimum spend, valid from / to, **source URL and checked-on date** |
| TR4-C.2 | Channels: HDFC Swiggy Orange card, Slice card, Roarbank card, UPI apps (Paytm, super.money), voucher platforms chosen by the owner (D4) |
| TR4-C.3 | Advisor input: merchant (or category) + amount. Output: ranked options with return in ₹, cap left this month (from transactions), reward unit, and the rule's source and date |
| TR4-C.4 | Rules older than 30 days are marked "check again"; expired rules are not used. No live-offer claims |
| TR4-C.5 | Advisor card on the Rewards page; optional hourly/daily agent step that refreshes rules from public sources with links |

---

## 5. Data design (migration 0012, additive only)
New tables: `wealth_reward_programs`, `wealth_reward_balances`, `wealth_reward_events`, `wealth_reward_rules`, `wealth_loans_given`, `wealth_loan_payments`. All with `user_id`, audit trigger (`wealth_trg_audit`), foreign keys to `wealth_accounts` / `wealth_transactions` with `ON DELETE SET NULL`. No change to existing tables except the Part 0 trigger. Rehearsed on Development with an encrypted Production backup before Production.

## 6. API (OpenAPI 3.x outline)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/rewards` | owner | programs, latest balances, cashback totals, advisor rules |
| POST | `/api/rewards/balances` | owner or ingest secret | add a balance (units, as-of, evidence); `dryRun` |
| POST | `/api/rewards/events` | owner or ingest secret | earned / redeemed / expired |
| POST | `/api/rewards/rules` | owner or ingest secret | add or close a rule (source URL required) |
| GET | `/api/rewards/advise?merchant=&amount=` | owner | ranked options |
| GET | `/api/loans` | owner | loans, payments, outstanding, suggestions |
| POST | `/api/loans` · `/api/loans/payments` | owner | create a loan / link a transfer as payment |

Validation: amounts > 0; units ≥ 0; dates not in the future; source URL required for rules; 400 / 401 / 403 / 409 as in Plan 3 §7.

## 7. Testing
PGlite tests per table and endpoint; UI tests for the Rewards, Lending and advisor views (same sandbox pattern as `records.test.mjs`); guard test for Part 0; no-deletion guard stays green.

## 8. Rollout
Part 0 → A → B → C, each: `claude-dev` → Development rehearsal → owner approval → `development` → `main`. Seeding reward balances and marking loans are owner-approved Production writes.

## 9. Risks
| Risk | Mitigation |
|---|---|
| Reward ₹ values guessed | Value only with a stated rate and source; otherwise show units only |
| Rules go stale (card offers change) | Checked-on date, 30-day "check again", expiry |
| Personal loans are sensitive | Store display names only, no phone / UPI ID; owner-only pages |
| Double counting cashback | Cash cashback only as transactions; points only in reward tables |

## 10. Delivery estimate
| Part | Size |
|---|---|
| 0 | Small (trigger, check, one repair) |
| A | Medium (migration, 3 endpoints, page, seed) |
| B | Medium (migration, 3 endpoints, page, Activity actions) |
| C | Medium (rules table, advisor logic, card) — depends on D4 |

---

## 12. Decisions needed (owner)
| ID | Question | Options |
|---|---|---|
| D0 | Slice Savings real balance now | ₹42,889.22 (after ₹5,000 to Arun S) · ₹47,889.22 · new screenshot |
| D1 | Which programs to track first | all seven in §1.2 · subset |
| D2 | Count rewards and money lent in net worth? | separate line only (recommended) · include |
| D3 | ₹ value per unit: Slice Monies, Slice Spark, Roarbank, HDFC points | owner screenshot of the redemption screen · leave as units |
| D4 | Voucher platforms you use or would use | e.g. Gyftr / HDFC SmartBuy, Amazon Pay, Paytm vouchers, super.money — owner to list |
| D5 | Which "Transfer sent" people are loans | owner reviews the suggestion list (TR4-B.5) |
| D6 | NDX P2P ₹15,000 (Nov 2023): still invested, withdrawn, or lost? | owner |
