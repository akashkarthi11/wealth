# Liabilities module

Credit cards, credit lines and other outstanding balances.

## Sources of liability data

| Source | Where it is used |
|---|---|
| `wealth_positions` with `category='LIABILITY'` (INR, `current_value` set) | Hero **Liabilities** card and net-worth total (`wealthPosition().liabilities`) |
| `wealth_transactions` with `kind='liability'` | Liabilities expanded detail list; Overview "LIABILITIES" mini card |

## Known issues

- **Two sources, two answers.** The headline total sums liability positions, while the detail list and the Overview mini card sum ledger liability entries. They can disagree.
- No staleness flag on `main`; branch `fix/net-worth-valuation-reconciliation` adds a > 48 h warning for the credit-card balance and lists liability positions in the detail (but still also lists ledger entries, so the detail can exceed the header).

## Related

- [Dashboard](../dashboard/README.md) · [Accounts](../accounts/README.md)
