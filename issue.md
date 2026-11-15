

---

## Issue: Dashboard net-worth data freshness and excluded-item warnings need actionable detail (observed 16 Nov 2026)

### What the screenshots show
- Home dashboard net worth: **₹4,37,120.70** (CASA ₹98,674.53 + investments ₹3,76,438.92 − liabilities ₹37,992.75). The arithmetic is correct.
- The dashboard says **“1 item not counted (see details)”** and **“8 accounts with values older than 48 h”**.
- The screenshots do not show which item is excluded, why it is excluded, which eight accounts are stale, or the age / last verified timestamp for each stale value.

### Why this needs attention
- The headline net worth can look complete even though one item is excluded from the calculation.
- Eight stale account values can materially distort CASA, investment, liability, and net-worth totals. A single generic warning is not enough to identify what needs refreshing.
- Users need to distinguish an intentionally excluded / unsupported item from a missing or failed balance.

### Follow-up
- Make “1 item not counted” open a detail list with the item, value, account, and exact exclusion reason.
- Make the stale-account warning open a list of all eight accounts with last balance timestamp, age, balance status, and a clear refresh/reconciliation action.
- Keep stale values visibly marked; do not silently treat them as freshly verified.
- Add a dashboard test that verifies the net-worth formula and the excluded/stale warnings independently.

---

## Issue: Cash & savings account rows have overlapping / concatenated labels on mobile (observed 16 Nov 2026)

### What the screenshots show
- In Home → CASA → Cash & savings accounts, the Atom row renders text like **“Atom · Atom SavingsSavings account · as of 16 Nov 2026Balance ₹55,363.00”** with fields running together.
- The row appears to combine the account title, account type, as-of date, balance status, and balance without adequate spacing or line wrapping.
- The Bank of India row is also close to the right edge / clipped by the visible screen area.

### Why this needs attention
- The mobile layout makes account identity and balance metadata difficult to read and can make separate fields look like one incorrect account name or value.
- This is especially risky when comparing multiple accounts or checking whether a balance is stale / verified.

### Follow-up
- Fix the mobile account-row layout with separate title, metadata, and balance regions; allow long labels to wrap and keep the amount aligned.
- Test at the screenshot viewport width (698 px image width; narrow mobile CSS viewport) and on smaller Android widths.
- Verify that account name, account type, as-of date, balance status, and balance remain visually distinct.

---

## Issue: Slice reward mapping card labels Monies as cashback and shows a rounded ₹29 reward (observed 16 Nov 2026)

### What the screenshots show
- The Toothsi expense is **₹2,962**, categorized as Medical and paid using Slice Credit Card ••6136.
- The Activity detail shows a “Map another reward” card with **“1% cashback”** and **“+29 ₹ cashback”**. One screenshot shows the toggle ON and another shows it OFF, while the reward offer text remains visible.
- Production has a Slice Monies reward event for this transaction: **2,962 Monies**, with configured value **₹29.62** (1 Monie per ₹1 spent; 100 Monies = ₹1).

### Why this needs attention
- Slice Monies are reward units, not immediately ₹29 cash cashback. Calling the reward “cashback” can overstate its liquidity / redeemability.
- Displaying ₹29 instead of ₹29.62 loses precision and does not explain the conversion (2,962 Monies = ₹29.62 estimated value).
- The toggle's ON/OFF state across the screenshots is ambiguous: it is not clear whether it controls an optional reward mapping, whether the mapping was saved, or whether the reward event already exists. A user could create a duplicate reward or believe a reward was removed when only the offer selection changed.

### Follow-up
- Render this reward as **“2,962 Slice Monies”** and, separately, **“estimated value ₹29.62”**; do not label it cash cashback unless the reward is actually cash-creditable.
- Explain the 1% calculation and the Monies-to-INR conversion in the UI.
- Define and test the toggle contract: what ON means, what OFF means, whether the selection persists, and whether “Map selected” inserts exactly one reward event.
- Make reward mapping idempotent per transaction + reward program; prevent duplicate events on repeated taps.
- Verify that the reward event and the UI label/value use the same program and conversion rule.

---

## Issue: Slice card billing-cycle spend and current card liability are different figures and need a clear reconciliation view (observed 16 Nov 2026)

### What the screenshots show
- Slice Credit Card screen: **₹37,737** spent for the cycle **21 Oct – 20 Nov**.
- My Wealth dashboard: total liabilities **₹37,992.75** across **3 cards**.
- The difference between these figures is **₹255.75**.

### Why this needs attention
- These are not necessarily the same metric: one is Slice's spend for a defined billing cycle, while the dashboard figure is total outstanding liability across three cards.
- Without a card-wise liability breakdown and statement / payment cut-off dates, the user cannot tell whether the ₹255.75 difference is expected (other cards, prior-cycle balance, fees, interest, pending postings) or a data mismatch.
- The UI currently places the two headline values in separate places without explaining their scope.

### Follow-up
- Show liability by card, with last verified balance timestamp, statement period, payments, refunds/credits, and pending transactions.
- Show Slice's billing-cycle spend separately from its current amount owed; never compare or overwrite one with the other as if they were equivalent.
- Reconcile the ₹37,737 cycle spend against Slice card transactions for 21 Oct–20 Nov using transaction references and posting dates. Do not insert a balancing transaction for ₹255.75 without source evidence.

---

## Issue: Overview payment alerts still need paid-item reconciliation (additional evidence observed 16 Nov 2026)

### What the screenshots show
- Home → Overview displays **“4 payment alerts · ₹10,020.00”**.
- The Activity view also shows the November rent payment recorded on 14 Nov in the existing ledger history; the earlier rent issue already noted that payment alerts did not look at transactions paid in the current month.

### Why this needs attention
- A payment that has already been made may continue to appear as due, inflating the alert count / amount and potentially prompting a duplicate payment.
- The screenshot does not expose the four alert names, so it does not prove that all ₹10,020 is incorrect; the rent alert is a known candidate to verify.

### Follow-up
- Reconcile each alert against accepted transactions, payment occurrences, and the relevant billing period before showing it as unpaid.
- Mark paid occurrences as paid / settled and exclude them from the due-alert total.
- Add regression coverage for rent paid during the month and for recurring bills with multiple occurrences.
- Inspect the four alerts individually before changing any due amount; do not assume the full ₹10,020 is wrong.
