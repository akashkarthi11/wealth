# "Other records" → Records page — 2026-11-11

**Status:** deployed — `main` `b8d040a` (build `20261111-claude-plan-3p`).

## Problem (owner: "what is other in app" → "give proper name, i need datas store in db, give better uiux")
- The menu item was called "Other records" / "Other", which says nothing about what it holds.
- It showed only `payload.sections` of saved records, so 13 of 30 `wealth_snapshots` records (holdings, FD summary, P&L, market prices, CDSL statement, margin statement, Stock Advisor runs) never appeared, and bank-balance sections were moved to Banks.
- One long page of tables with no search, type or date grouping.

## Change (`app.js`, `style.css`, `index.html`)
- Name: menu **Records** ("Statements, screenshots and reports"); page title **Statements & records**.
- Lists **every** record in `wealth_snapshots` (from `window.__wealthSnapshots`, already in the dashboard payload; no API change), newest first, grouped by month.
- Each card: type badge (Statement / Screenshot / Holdings / Report / Note, from the record name), title without the trailing date, date · source · counts ("16 holdings", "3 sections"), and up to 3 key figures from `summary` / `totals` / top-level numbers.
- Opening a card shows all saved data: sections (existing tables and notes), key/value tiles for values, tables for lists of items (holdings, monthly rollups, P&L rows), bullet lists for notes, nested groups for objects.
- Hidden: internal keys (`kind`, `source`, `snapshotDate`, `importedAt`, `section`) and `client_code`.
- Search across names and all stored values; type chips with counts (a type with no records has no chip).
- Read-only; totals still come from accounts and holdings.

## Verification
- `scripts/tests/records.test.mjs` (5); full suite 147/147; homepage validation passes (`recordsList`, `recordsSearch` are runtime IDs).
- Rendered against the 30 Production records (read-only): every card has content, page ≈ 100 KB, no PAN / phone / email patterns.
