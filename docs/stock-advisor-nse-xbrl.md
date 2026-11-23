# NSE Integrated Filing XBRL source

The Stock Advisor's primary financial-statement source is the NSE-filed XBRL instance XML. Fincrux remains a secondary, unverified source.

## Discovery and URL resolution

The input is the most recent stored NSE RSS item where:

- `publisher = 'NSE'`
- `source_type = 'financial_statement'`
- `evidence->>'feed_label' = 'Financial results'`
- `run_id IS NULL`

The stored announcement URL is fetched first and audited. The XBRL attachment is not guessed by rewriting that PDF URL. The collector then queries NSE's Integrated Filing endpoint for the same ticker and announcement date:

```
https://www.nseindia.com/api/integrated-filing-results
  ?index=equities
  &type=Integrated Filing- Financials
  &page=1
  &size=50
  &period_ended=all
  &symbol=<ticker>
  &from_date=<DD-MM-YYYY>
  &to_date=<DD-MM-YYYY>
```

The API is undocumented and may change. The collector records each raw HTTP response's status, content type, byte count and a short safe preview before JSON/XML parsing. It then validates the parsed response shape and fails closed if `data` is not an array or expected filing fields are absent. NSE Circular NSE/CML/2025/20 (2 April 2025) requires the PDF financial-results announcement and its Integrated Filing - Financial XBRL submission on the same date; this supports the IST-day match when the API's `pdf_attach` field is null. [NSE circular](https://nsearchives.nseindia.com/web/sites/default/files/inline-files/NSE_Circular_02042025_0.pdf).

A real NSE response observed on 12 November 2026 contained `data[]` rows with fields including `symbol`, `cmName`, `broadcast_Date`, `creation_Date`, `qe_Date`, `consolidated`, `audited`, `type_Sub`, `pdf_attach`, `ixbrl`, and `xbrl`. One observed HDFIRE record had `pdf_attach: null` while `xbrl` was present. The XBRL URL is therefore taken only from the response's `xbrl` field.

Observed raw XBRL archive URL shape:

```
https://nsearchives.nseindia.in/corporate/xbrl/
  INTEGRATED_FILING_INDAS_<archive-file-id>_<DDMMYYYYHHMMSS>_WEB.xml
```

For example, an observed URL was:

```
https://nsearchives.nseindia.in/corporate/xbrl/INTEGRATED_FILING_INDAS_1757091_12112026111411_WEB.xml
```

The readable iXBRL companion was a different path and had a different numeric ID:

```
https://nsearchives.nseindia.in/corporate/ixbrl/INTEGRATED_FILING_INDAS_213257_12112026231412_iXBRL_WEB.html
```

Do not derive either attachment by replacing part of the stored PDF URL, and do not derive the XBRL filename from the iXBRL filename. Use the exact `xbrl` URL returned by NSE. Both `.com` and `.in` NSE archive hosts have been observed; the collector allows both.

## Filing matching

A candidate must match:

1. Exact NSE ticker and `Integrated Filing- Financials` type.
2. The stored announcement's company name (or ticker) in the announcement title.
3. Either an exact `pdf_attach` URL match or the same IST broadcast date.
4. The reporting period when the stored announcement title/excerpt states one.

If multiple candidates match, consolidated is preferred; within that basis, the latest revision/creation timestamp is selected. Standalone is used only when no consolidated candidate matches. The filing basis and revision metadata are retained in evidence.

## XBRL facts and contexts

The Integrated Filing instance is a flat XBRL document. The observed primary contexts are:

- `OneD`: current reporting period income statement and EPS.
- `FourD`: year-to-date income statement and cash-flow facts.
- `OneI`: reporting-date balance sheet.

The parser prefers `OneD` for the headline period, uses `FourD` for operating cash flow when present, and `OneI` for assets/equity when present. It records the exact qualified element name, raw value, numeric value, unit reference, decimals and context reference for every figure it reads.

Currently supported element aliases include:

| Advisor field | XBRL element names |
|---|---|
| Revenue | `RevenueFromOperations`, `TotalRevenueFromOperations` |
| Interest earned (banking) | `InterestEarned` |
| Total income | `Income`, `TotalIncome` |
| Profit before tax | `ProfitBeforeTax`, `TotalProfitBeforeTax` |
| Net profit | `ProfitLossForPeriod`, `ProfitLossForThePeriod`, and listed after-tax variants |
| EPS | `BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations`, `BasicEarningsLossPerShareFromContinuingOperations`, and listed basic-EPS variants |
| Total assets | `Assets`, `TotalAssets` |
| Total equity | `Equity`, `TotalEquity`, `ShareholdersFunds` |
| Operating cash flow | `NetCashFlowsFromUsedInOperatingActivities` and listed variants |

Banking, NBFC, Ind-AS and older non-Ind-AS taxonomies differ. Missing concepts remain absent; the parser never substitutes another metric under a misleading label. NSE's numeric facts are full rupee values; the `decimals` attribute is precision, not a scale factor. No rounding-to-crore/lakh conversion is applied.

## Verification and audit

Every outside request (stored announcement PDF, Integrated Filing metadata, XBRL XML) is recorded through `recordApiCall()`. The XBRL request is audited before XML parsing. Only a successfully parsed document with a valid period, at least one supported fact, and no ticker/period mismatch is inserted as `publisher='NSE'`, `source_type='financial_statement'`, `verification_status='verified'`.

The evidence stores the original announcement URL, the exact XBRL URL, period, filing basis, revision metadata, exact element names and figures. A download, response-shape, parse, company, ticker or period failure writes no verified research source.

The parser test fixture under `scripts/tests/fixtures/` is explicitly synthetic and is used to test XML parsing/context selection; it is not represented as a real issuer filing. The live NSE response and URL shape were separately inspected during implementation.
