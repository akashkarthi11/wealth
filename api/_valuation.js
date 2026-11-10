// Single valuation rule for the account hierarchy (TSD §7.4, TR-5.3, TR-5.7).
// Pure function: rows in, valued accounts and totals out. All sums are done in integer paise.
//
//   CASA / FD / EPF / liability  -> latest balance (converted to INR if the account is in USD)
//   holding                      -> quantity × latest price; USD × fx_to_inr of that price row,
//                                   else the latest timestamped USD/INR (≤ 36 h); else null (missing_fx)
//   net worth                    -> Σ CASA + Σ INVESTMENT − Σ LIABILITY
//   Values that cannot be trusted (pending reconciliation, missing price or FX) are listed in
//   totals.excluded and are NOT added.

export const FRESH_PRICE_MS = 36 * 3600 * 1000;
export const STALE_BALANCE_MS = 48 * 3600 * 1000;
export const LIVE_SOURCES = new Set(['Yahoo Finance', 'MFAPI.in']);

const paise = n => Math.round(Number(n) * 100);
const rupees = p => p / 100;
const ts = x => (x == null ? NaN : new Date(x).getTime());

function fxFor(priceFx, marketFx, now) {
  if (Number(priceFx) > 0) return Number(priceFx);
  if (marketFx && Number(marketFx.rate) > 0 && now - ts(marketFx.as_of) <= FRESH_PRICE_MS) return Number(marketFx.rate);
  return null;
}

export function valueHolding(h, { marketFx = null, now = Date.now() } = {}) {
  const quantity = Number(h.quantity);
  const hasPrice = h.price != null && Number(h.price) > 0;
  const valuePaise = hasPrice ? paise(quantity * Number(h.price)) : null;
  let valueInrPaise = null, status;
  if (!hasPrice) status = 'missing_price';
  else {
    if (h.currency === 'INR') valueInrPaise = valuePaise;
    else { const fx = fxFor(h.fx_to_inr, marketFx, now); valueInrPaise = fx ? paise(rupees(valuePaise) * fx) : null; }
    if (valueInrPaise == null) status = 'missing_fx';
    else if (!LIVE_SOURCES.has(h.price_source)) status = 'manual';
    else status = now - ts(h.fetched_at ?? h.price_as_of) <= FRESH_PRICE_MS ? 'fresh' : 'stale';
  }
  return {
    instrumentId: h.instrument_id, symbol: h.symbol, name: h.name, assetClass: h.asset_class, unit: h.unit,
    quantity,
    price: { amount: hasPrice ? Number(h.price) : null, currency: h.currency },
    priceAsOf: h.price_as_of ?? null, priceSource: h.price_source ?? null,
    value: { amount: valuePaise == null ? null : rupees(valuePaise), currency: h.currency },
    valueInr: valueInrPaise == null ? null : rupees(valueInrPaise),
    invested: { amount: h.invested_value == null ? null : Number(h.invested_value), currency: h.currency },
    valuationStatus: status,
  };
}

export function valuePortfolio({ accounts = [], balances = [], holdings = [], marketFx = null, now = Date.now() } = {}) {
  const latest = new Map(balances.map(b => [b.account_id, b]));
  const byAccount = new Map();
  for (const h of holdings) {
    if (!byAccount.has(h.account_id)) byAccount.set(h.account_id, []);
    byAccount.get(h.account_id).push(h);
  }
  const totals = { CASA: 0, INVESTMENT: 0, LIABILITY: 0 };
  const excluded = [];

  const valued = accounts.map(acc => {
    const b = latest.get(acc.id) || null;
    let accountPaise = 0, complete = true, stale = false;

    // Balance part (cash, deposit value, broker cash, or amount owed).
    let balanceInrPaise = null;
    if (b && b.balance != null) {
      if (acc.currency === 'INR') balanceInrPaise = paise(b.balance);
      else { const fx = fxFor(null, marketFx, now); balanceInrPaise = fx ? paise(Number(b.balance) * fx) : null; }
      if (now - ts(b.as_of) > STALE_BALANCE_MS) stale = true;
      if (b.status === 'pending_reconciliation') {
        excluded.push({ accountId: acc.id, amount: balanceInrPaise == null ? null : rupees(balanceInrPaise), reason: 'pending_reconciliation' });
        complete = false;
      } else if (balanceInrPaise == null) {
        excluded.push({ accountId: acc.id, amount: null, reason: 'missing_fx' });
        complete = false;
      } else accountPaise += balanceInrPaise;
    }

    // Holdings part.
    const items = (byAccount.get(acc.id) || []).map(h => valueHolding(h, { marketFx, now }));
    for (const it of items) {
      if (it.valuationStatus === 'stale') stale = true;
      if (it.valueInr == null) {
        excluded.push({ accountId: acc.id, symbol: it.symbol, amount: it.value.amount, currency: it.value.currency, reason: it.valuationStatus });
        complete = false;
      } else accountPaise += paise(it.valueInr);
    }

    if (acc.category in totals) totals[acc.category] += accountPaise;
    return {
      id: acc.id, category: acc.category, subtype: acc.subtype, subtypeLabel: acc.subtype_label ?? acc.subtype,
      valuation: acc.valuation, institution: acc.institution, name: acc.name,
      maskedIdentifier: acc.masked_identifier ?? null, currency: acc.currency,
      balance: { amount: b?.balance == null ? null : Number(b.balance), currency: acc.currency },
      balanceAsOf: b?.as_of ?? null, balanceStatus: b?.status ?? null, balanceNote: b?.note ?? null,
      holdings: items,
      valueInr: rupees(accountPaise), complete, stale,
    };
  });

  return {
    accounts: valued,
    totals: {
      casa: rupees(totals.CASA),
      investments: rupees(totals.INVESTMENT),
      liabilities: rupees(totals.LIABILITY),
      netWorth: rupees(totals.CASA + totals.INVESTMENT - totals.LIABILITY),
      excluded,
    },
  };
}
