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
| Status | **Draft** — Part 0 built (§13), Parts A–C waiting for owner decisions (§12) |
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

---

## 13. Implementation status

### Part 0 — balance-write guard (2026-11-11, owner: "Part 0 solve it")
| ID | State | Evidence |
|---|---|---|
| TR4-0.1 | **Built** — migration [`0012_external_balance_guard.sql`](../../scripts/migrations/0012_external_balance_guard.sql): when `wealth.actor` is not set (direct SQL, audit actor `external`), the database refuses (a) `pending_reconciliation` on `wealth_accounts.balance_status` or `wealth_account_balances.status`, and (b) moving `wealth_accounts.balance_as_of` back in time. Newer `stale` / `verified` balances are still allowed, as rules.md §2 says. The app, owner repairs, agents and cron set an actor and are unaffected | `balance-guard.test.mjs` (4); Development: migration applied (13 total); live check in rolled-back transactions — both bad writes refused, newer stale balance and owner write allowed |
| TR4-0.2 | **Built** — data-quality issue `balance_mismatch` (high) when the dashboard balance differs from the newest balance-history row, or the history is newer | `balance-guard.test.mjs` (flags the Slice case, clears when they agree) |
| TR4-0.3 | **Waiting for D0** — the owner confirms the real Slice Savings balance; then one owner-approved repair records it so both places agree | — |

**Refinement 0013** (owner: "my chatgpt run the task so it need to write in db"): a back-dated balance is allowed when it is `verified` (bank evidence, e.g. a late-recorded screenshot); only back-dated estimates are refused. ChatGPT's normal writes — prices, Gmail transactions, email imports, advisor reports, newer stale/verified balances — were never affected. Development: 0013 applied (14 migrations), live check passed.

Production: needs deploy (`main` build applies 0012 and 0013) after an encrypted backup. Full suite 154/154.

### Part 0 — in Production (2026-11-11)
Owner "main": backup `prod-before-0012.wlb` (32 tables, 5,774 rows); `main` `f344277` (build `3u`) applied 0012 and 0013 (14 migrations). Live check in rolled-back transactions on Production: external `pending_reconciliation` refused, external back-dated estimate refused, back-dated verified allowed, newer stale allowed, owner allowed; nothing changed.

### Part A — Rewards & points (2026-11-11, owner: "a")
Defaults taken without an answer: D1 = all programs; D2 = shown apart from net worth; D3 = ₹ value only where a rate with a source exists.
| ID | State | Evidence |
|---|---|---|
| TR4-A.1–A.3 | **Built** — migration [`0014_rewards.sql`](../../scripts/migrations/0014_rewards.sql): `wealth_reward_programs` (rate needs `rate_source`; `cash_match` for programs paid as money), `wealth_reward_balances` (append-only, verified / estimated), `wealth_reward_events`; audited. [`0015`](../../scripts/migrations/0015_rewards_drop_duplicate_index.sql) drops a redundant index | `rewards.test.mjs` |
| TR4-A.4 | **Built** — cash rewards (Spark, card cashback) are summed from income transactions by `cash_match` (scoped to the linked card); nothing is copied | test: HDFC card cashback counted, the Swiggy expense on the same card not |
| TR4-A.5 | **Seed ready** — [`2026-11-11-seed-reward-programs.sql`](../../scripts/db/repairs/2026-11-11-seed-reward-programs.sql): Paytm Gold Coins (430 → 431 → 436, ₹0.01/coin, redeem at 500), Slice Monies (1,30,954 → 1,42,378; ₹0.01/Monie from the 9 Nov screen "₹1,423.78" — another screen showed ₹0, owner to confirm), Slice Spark (cash), Slice card cashback (cash, card ••6136), HDFC Swiggy Orange (0 points on 8 Nov + 5% Swiggy cashback on ••9229), Roarbank rewards (no balance yet). Development: 6 + 6 rows, re-run 0 | — |
| TR4-A.6 | **Built** — `GET /api/rewards`, `POST /api/rewards/balances`, `/api/rewards/events`, `/api/rewards/programs` (owner or ingest secret, `?dryRun=1`; a ₹ rate requires its source) | `rewards.test.mjs` |
| TR4-A.7 | **Built** — Rewards page (Money menu and More): points value total, cashback this month / year / all time, one card per program (units, ≈ ₹ value or "₹ value not set", progress to redemption, verified date, notes, "Update" form), cash programs with month / year / all-time totals, cashback by type, "How this works" | page test; visual check at 540 px with Development data |
| TR4-A.8 | **Built** (build `3y`) — Alerts page "Rewards" section and the alert badge: ready to redeem, within 10 % of the threshold, or expiring within 30 days (when a balance has `expires_on`). Dashboard: a "Rewards & cashback" tile (points value, cashback this month) opening the Rewards page; the dashboard payload carries the rewards overview (owner only, never blocks the dashboard) | `rewards.test.mjs` (alerts, tile, badge) |

Development (real data): points value ₹1,428.14 (2 of 6 programs priced); cashback ₹450 this month, ₹3,698.55 all time (44 credits); HDFC Swiggy cashback ₹577; Slice card cashback ₹2,665.85; Spark ₹450. Build `20261111-claude-plan-3v`; full suite 164/164.

**Part A complete in code** (build `3y`, 165/165 tests). Production still needs: deploy (`main`) and the owner-approved seed. Owner inputs: which Slice Monies cash value is withdrawable (₹1,423.78 vs ₹0); a Roarbank rewards balance.

**Seed in Production** (owner: "approve rewards seed", 2026-11-11): backup `prod-before-rewards-seed.wlb` (35 tables, 5,778 rows); INSERT 6 programs + 6 balances; re-run 0. Production overview: points value ₹1,428.14 (Paytm 436 coins, Slice 1,42,378 Monies), cashback ₹3,698.55 all time (Spark ₹450, Slice card ₹2,665.85, HDFC Swiggy ₹577). Audited as owner.

### Slice Monies reward scheme (build `3z`, owner: "for monis there are reward scheme" → basis "% of my spends")
- Migration [`0016_reward_scheme.sql`](../../scripts/migrations/0016_reward_scheme.sql): `wealth_reward_programs.scheme` (jsonb object): `{basis:"spend", rate, spend_bank, tiers:[{at, rate, label}]}`.
- Repair [`2026-11-11-slice-monies-scheme.sql`](../../scripts/db/repairs/2026-11-11-slice-monies-scheme.sql): Slice Monies earn 1% of spends (≈ 1 Monie per ₹1 at ₹0.01/Monie); locked rate 2% from 5,00,000 Monies (9 Nov screenshot). Spends counted: expenses on Slice accounts (assumption, shown on the card).
- Monies card: scheme line, progress to the 2% tier (1,42,378 / 5,00,000 = 28.5%, 3,57,622 to go ≈ ₹3.58 lakh of spends), Slice spends this month, estimated Monies earned, average monthly spend (90 days), months to the tier at that pace.
- Development: 0016 applied (17 migrations), repair UPDATE 1 then 0; card checked visually (₹829 spent this month ≈ 829 Monies; average ₹40,456.83/month → about 9 months). Tests 166/166.

### Rewards UX and account links (build `4a`, owner: "i need better uiux for reward and every thing link to account")
- **Links:** migration [`0017`](../../scripts/migrations/0017_reward_cash_any_account.sql) adds `cash_any_account`; repair [`2026-11-11-link-reward-accounts.sql`](../../scripts/db/repairs/2026-11-11-link-reward-accounts.sql) links Paytm Gold Coins → Paytm Gold (digital gold), Slice Monies → Slice Savings ••3731, Slice Spark → Slice Savings ••3731 (its credits have no account → counted from any account), Roarbank rewards → Roarbank Credit Card. Card cashback programs were already linked. `POST /api/rewards/programs {programId, accountId}` changes a link (own accounts only).
- **Page:** grouped by bank/app (largest first) with linked accounts and group totals; filters All · Points · Cashback; compact cards (main figure first, account chip that opens the bank page — or Investments for gold — progress, scheme, Details folded); empty programs show "No balance yet — Add"; the Update form has the units (points programs) and a Linked account select; cashback by type folded.
- **Bank pages:** a Rewards section lists the programs linked to that bank.
- Development: 0017 applied (18 migrations); links UPDATE 3 (Development has no Roarbank credit card; Production has it), re-run 0; checked visually at 540 px. Tests 167/167.

### Deployed (2026-11-11, owner: "ok use it now", "approve rewards links")
- Backup `prod-before-0016.wlb` (35 tables, 5,802 rows); `main` `35b2934` (build `4a`) applied 0016, 0017, 0018 (19 migrations).
- Backup `prod-before-reward-links.wlb` (36 tables, 5,806 rows); Monies scheme UPDATE 1 (re-run 0); account links UPDATE 4 (re-run 0). All six programs linked: HDFC Swiggy Orange ••9229, Paytm Gold, Roarbank Credit Card, Slice Credit Card ••6136, Slice Savings ••3731 (Monies, Spark — Spark counts credits from any account).

### Spark merged into Slice card cashback (2026-11-11, owner: "merge it 1")
Repair [`2026-11-11-merge-slice-spark-cashback.sql`](../../scripts/db/repairs/2026-11-11-merge-slice-spark-cashback.sql): program `slice-card-cashback` renamed "Slice cashback (card + Spark)", `cash_match` = `credit card cashback|spark`, counted from any account (checked: matches only the Slice card's 24 cashback credits and the 3 Spark credits); program `slice-spark` closed (hidden, kept). No transaction changed. Development and Production: UPDATE 1 + 1, re-run 0; backup `prod-before-spark-merge.wlb` (36 tables, 5,842 rows). Production now: 5 programs; Slice cashback ₹3,115.85 all time (card ₹2,665.85 May–Jul + Spark ₹450 Nov). Note: no card cashback is recorded for Aug–Oct 2026 although ₹2.2 lakh was spent on the card — owner to send a statement if cashback was paid.

### Reward schemes: Monies tiers and HDFC Swiggy 5% (build `4c`, owner: "after reach 300000 monies its 1.5 % after 5l its 2%", "hdfc provide 5% when i buy in swiggy with hdfc card")
- Scheme engine: tiers set the current rate (highest tier reached); `spend_scope: "account"` counts only spends on the linked account; `merchant` filters spends (regex on category/description); cash programs earn ₹ directly (1 unit = ₹1).
- Card: tier chips with the current rate highlighted; progress to the next tier; cash schemes show spends this month, expected cashback and credited this month, with a note when expected exceeds credited.
- Repair [`2026-11-11-reward-schemes-tiers-and-swiggy.sql`](../../scripts/db/repairs/2026-11-11-reward-schemes-tiers-and-swiggy.sql): Slice Monies 1% → 1.5% from 3,00,000 → 2% from 5,00,000 (next tier now 3,00,000: 1,57,622 Monies to go, about 4 months at the current pace); HDFC Swiggy Orange 5% of Swiggy orders on the card. Development: UPDATE 2 then 0 (label fix UPDATE 1 then 0). **Production: waiting for owner approval and deploy.** Monthly HDFC offers to be added when the owner shares them.

### November interest and round-ups (2026-11-11, from `issue.md`; owner: "yes, approve interest fix")
Repair [`2026-11-11-november-interest-and-roundups.sql`](../../scripts/db/repairs/2026-11-11-november-interest-and-roundups.sql): six interest rows inside the 11 Nov month-to-date totals marked `duplicate_of` (Slice ₹35.53, ₹42.74, ₹7.20, ₹7.21 → ₹71.57; Atom ₹9.55, ₹9.56 → ₹76.36) — ₹111.79 of double-counted income removed; round-ups ₹141 and ₹18 moved to Atom Savings ("Slice Atom", owner confirmed). Stops unless exactly 6 + 2 rows match; re-run 0. Backup `prod-before-interest-fix.wlb` (36 tables, 5,855 rows). `issue.md` updated with the resolution and rules 9–11.
**Next (owner):** Atom splits (pots, e.g. Rent) — screenshot with split names, balances and targets; which split takes round-ups; rent amount, due day and split.

### Monies from card spends only (owner: "every card spend it add against monis")
Checked against screenshots: Monies 1,42,378 (9 Nov) → 1,42,399 (11 Nov) = +21 = 1% of the ₹21 Slice card spend (MMTC PAMP); Slice Savings spends (Gullak ₹1, ₹5,000 to Arun S) earned none. Scheme engine: `spend_account_type` filter; Monies scheme now `spend_account_type: "credit_card"`, label "Slice card spends". Development: UPDATE 1 then 0. Production waits for "approve schemes" (with "main" for the code).

### Atom splits (build `4d`, owner: "this is splits", Atom screen 11 Nov 5:21 PM)
- Migration [`0019_account_splits.sql`](../../scripts/migrations/0019_account_splits.sql): `wealth_account_splits` (name, kind goal/roundups/general, goal, purpose), `wealth_account_split_balances` (verified/estimated history), `wealth_account_split_moves` (signed: + into, − out of the split; optional transaction link, one move per transaction per split). Audited; bumps the data version. Splits never change account balances or totals.
- `api/_splits.js`: estimated split balance = latest split balance + moves after it; `GET /api/splits?accountId=`, `POST /api/splits/balances`, `POST /api/splits/moves` (owner or ingest secret; a move cannot point at a transaction on another account). Account detail includes `splits`.
- Account page (e.g. Atom): "Splits" — share bar (tap to read), each split with balance, verified/estimated (with the change since the screenshot), goal progress when a goal exists, last moves, and a check that the splits add up to the account balance.
- Seed [`2026-11-11-atom-splits.sql`](../../scripts/db/repairs/2026-11-11-atom-splits.sql): Invest later ₹30,036 · Rent ₹8,209 · Emergency fund ₹25,030 · Round ups ₹172 (verified 11 Nov 5:21 PM; Atom ₹63,448.36); November round-ups ₹141 and ₹18 linked to Round ups as history. Development: 0019 applied (20 migrations), seed INSERT 4+4 then 0. **Production: waiting for "main" and "approve splits".**
- Also fixed: the hidden tap readout under share bars showed as an empty box (`.share-readout[hidden]`).
- Tests: `splits.test.mjs` (4). Full suite 178/178.
- Next: rent — amount and due day, then rent payments create a − move on the Rent split; ChatGPT rule to post Atom movements with their split.

### Applied in Production (owner: "approve schemes", "approve balances")
- Backup `prod-before-balances-schemes.wlb` (36 tables, 5,863 rows).
- Schemes: UPDATE 2 — Slice Monies 1% of Slice card spends → 1.5% from 3,00,000 → 2% from 5,00,000; HDFC Swiggy Orange 5% of Swiggy orders on the card. (The full card-only / Swiggy display needs build `4c`/`4d` deployed.)
- Verified balances via the app's own path (account record and history in step): Slice Savings ₹42,871 (11 Nov 5:19 PM), Atom Savings ₹63,448.36 (5:21 PM), Slice Monies 1,42,399 (≈ ₹1,423.99). Slice Savings record and history now both ₹42,871 — the ₹5,018 mismatch (D0) is closed.
- "approve splits" received; the splits need migration 0019, which reaches Production with the next deploy ("main") — applied after it.

### Splits in Production; interest rule (2026-11-11)
- Build `4d` live (`main` `cdb8e20`, 0019 applied, 20 migrations). Atom splits added (owner "approve splits"): INSERT 4 splits, 4 verified balances, 2 round-up moves; re-run 0. Splits ₹63,447 vs Atom ₹63,448.36 (rounding).
- Owner rule: screenshots show interest as a full/running total — **never save interest from a screenshot**; the nightly interest task records it. Added as `rules.md` §2a; `issue.md` rule 9 changed to match.

### Interest rows from the app, not screenshots (owner: "2 find real amount and replace here")
- Repair [`2026-11-11-interest-rows-real-amounts.sql`](../../scripts/db/repairs/2026-11-11-interest-rows-real-amounts.sql) (backup `prod-before-interest-real.wlb`, 39 tables, 5,921 rows): the two screenshot interest rows now carry the app's figures through 10 Nov — Slice Savings ₹71.58 (statement ₹64.36 + accrual ₹7.2151; screenshot said ₹71.57), Atom Savings ₹76.36 (₹66.80 + ₹9.5564) — and `external_ref interest-month:<product>:2026-11`. UPDATE 2, re-run 0. The six older rows stay marked as duplicates; nothing deleted (deletion declined by the owner).
- Code: `upsertMonthInterestRow` — after each nightly accrual, every daily-credited product (Slice Savings, Atom) has ONE income transaction per month = latest statement in the month + accruals after its end date, updated in place; a new month starts a new row. Tests `interest-month-row.test.mjs` (2). Needs deploy.

### Interest shared across Atom splits (build `4e`, owner: "interest also split for atom and update against their balance")
- `splitInterest()` in `api/_splits.js`: each accrual day's interest from the nightly task (interest ledger for the account, accrual days on or after the split's screenshot day — the 5:21 PM screenshot already includes 10 Nov) is shared across the splits by balance (screenshot + moves + interest already shared), largest-remainder rounding to paise so shares add up exactly. Derived on read, nothing stored, no double counting; a new screenshot resets each split.
- Split rows show "estimated (+₹X since 11 Nov incl. ₹Y interest)". Production now: all four splits verified (11 Nov interest is accrued tonight). Test added to `splits.test.mjs`; full suite 181/181.

### Part B — Money lent & split bills (build `4g`, owner: "now start next plan"; "i need bill amount and split with person or choose amount for each person and split gst to all")
- Migration `0020_people_and_bill_splits` (additive): `wealth_people` (own contacts — names only, not app users; due date, rate, status open / settled / written_off), `wealth_person_entries` (out = lent, in = paid back; a transfer links to one person only), `wealth_bill_splits` (total, GST inside it, equal / amounts; one active split per transaction; cancelled, never deleted), `wealth_bill_split_shares` (person or the owner: base + GST share = amount). Audit and data-version triggers.
- Owes you = bill shares + lent − paid back (+ simple interest when a rate is set). Bills stay expenses and transfers stay transfers — no other total changes. Not in net worth (D2 default).
- GST: entered as ₹ or %; shared in proportion to each part (equal split → equal GST). Largest-remainder paise so shares add up exactly; the sheet's live numbers use the same maths as the server.
- API (owner only, `?dryRun=1`): `GET /api/loans`, `POST /api/loans/people`, `/entries` (link transfers or cash), `/splits`, `/splits/cancel`.
- UI: "People" menu → Money lent & split bills (who owes what, entries, split bills, suggestions to review); split sheet opens after saving an expense ("Split this bill with people?"), from "Split bill" on any expense in Activity, and from "＋ Split a bill"; transfers get "Lent to a person" / "Paid back by a person".
- Tests: `scripts/tests/loans.test.mjs` (maths, splits, entries, suggestions, safety, page). Development rehearsal: 0020 applied, overview and a dry-run split checked.
- Open: D5 (which suggested people are real loans — owner reviews the list), D6 (NDX P2P ₹15,000). Spending still counts the full bill; showing only "your share" in spending totals is a possible follow-up.

### People: links in Activity, paid, round-off; sign-out fix (build `4h`, migration 0021)
- Owner: "it need to show in transaction … if it single person directly mention that person … in lend paid button, split paid option … roundoff mean close all lend and create one new lend with reference of all closed and count total and decide how much already back".
- Activity rows carry a tag: "Lent · Arun S", "Paid back · Arun S", "Split · 2 people · 1 to pay". A transfer whose description names one person gets a one-tap "Lent to Arun S" / "Paid back by Arun S"; "Someone else / several people" opens the People page with the transfer waiting (one person, or split among several — a transfer sent can now be split). "Change person" moves the entry (`POST /api/loans/entries/move`).
- People page: **Paid** (money back by hand, prefilled with what is owed), **Mark paid** on each bill share (`POST /api/loans/shares/paid`, once per share), **Round off** (`POST /api/loans/roundoff`): closes every open entry and share into `wealth_person_rollups` (total owed, already back as decided by the owner, new amount), carries one new entry with `rollup_ref`; closed items stay as history and cannot be moved.
- Migration `0021_lending_paid_and_roundoff` (additive): `wealth_person_rollups`; `split_id`, `rollup_id`, `rollup_ref` on entries; `rollup_id` on shares; one paid entry per share. Rehearsed on Development.
- Sign-out / Clear session: `Clear-Site-Data: "cache"` removed (Chrome held the sign-out response, so the cookie was not removed before the reload); sign-out is a plain fetch with a fallback to `GET /api/clear-session`, then `location.replace('/')`. Clear session is now a confirmed `POST /api/clear-session` that ends every device (session_version + 1) and resets this browser's saved app settings.

### One record at a time; History with ₹0 (build `4i`, migration 0022)
- Owner: "write off per record … after all settle it need to list in history with 0, we can delete if i mistake touch that us lend".
- `0022_lending_entry_status` (additive): `status` on entries (active · written_off · removed) and on bill shares (active · written_off); people can be `removed`; one-link-per-transaction / one-payment-per-share ignore removed entries.
- `POST /api/loans/records`: **Write off** one entry or bill share (listed, struck through, not counted; **Undo** brings it back); **Remove (mistake)** for an entry linked by a wrong tap — hidden and not counted, the transaction stays in Activity and can be linked again. Nothing is deleted. A person with nothing left can be removed.
- People who owe nothing (paid back, settled, written off) move to **History · owe ₹0**, still listing their entries. Activity tag shows "· written off".

### Shared link, "I've paid" requests, bell, People redesign (build `4j`, migration 0023)
- Owner: "gen url for user in lend so they can see their lend and after paid then ask request to close … notification icon top right … if i close it need to add balance to bank and close lend" · "money lend screen need better uiux".
- `0023_lend_share_and_requests` (additive): `wealth_people.share_token_hash` (SHA-256 of the link secret — the link is shown once; a new link replaces it), `wealth_lend_requests` (amount, date, method, note, pending / accepted / declined, account, transaction, balance_added, closed_lend).
- Public page `/l/<secret>` (vercel.json rewrite → `lend-view`): that person's own entries only (no account names, transaction text or other people), "I've paid" form (≤ 3 waiting, rate-limited per IP), noindex, no-store.
- Owner: `POST /api/loans/share` (create / revoke), `POST /api/loans/requests/decide` — **Accept** records a received transfer on the chosen bank account (`external_ref lend-request:<id>`) + a paid-back entry; **add to balance** (on by default) writes a new balance row (`reported`, note) and `wealth_accounts` (`stale` — an owner-confirmed estimate, rules.md §2); **close the lend** sets the person to settled. One database transaction. **Not received** declines. Lending again / splitting reopens a settled person.
- Bell (top right): waiting requests, refreshed on sign-in, every 3 minutes and when the tab returns; tap → People page with that request open.
- People page redesign: header total + stats + actions → waiting payments → tabs (Owe you · Split bills · History · To review) → compact person rows → person detail (Paid, Round off, Share link, Edit; entries with Write off / Undo / Remove (mistake) / Change person / Mark paid).
