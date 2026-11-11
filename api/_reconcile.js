// v1 vs v2 reconciliation (TSD Claude Plan 2, Phase D, TR2-D.1).
// v1Totals is a faithful server-side port of app.js wealthPosition() (the live dashboard); a test runs
// both on the same rows and requires identical results.

const n = v => Number(v || 0);
const r2 = v => Math.round(v * 100) / 100;

function usHoldingInrValue(p) {
  const cv = p?.metadata?.inr_conversion || {};
  const direct = Number(p?.market_value_inr);
  if (p?.market_value_inr != null && Number.isFinite(direct)) return direct;
  const saved = Number(cv.current_value_inr);
  if (cv.current_value_inr != null && Number.isFinite(saved)) return saved;
  const fx = Number(p?.market_fx_to_inr || cv.usd_inr_rate || 0);
  const usd = Number(p?.current_value || 0);
  return Number.isFinite(fx) && fx > 0 && Number.isFinite(usd) ? usd * fx : 0;
}

export function v1Totals(accounts, positionsIn) {
  const positions = positionsIn.filter(p => !String(p.record_type || '').endsWith('_ARCHIVED'));
  // 'stale' = estimated (verified balance + interest since, Plan 3 nightly job): counted, like app.js.
  const verified = accounts.filter(a => (a.balance_status === 'verified' || a.balance_status === 'stale') && a.current_balance != null
    && String(a.currency || 'INR').trim() === 'INR' && /^(savings|current)$/i.test(String(a.account_type || '')));
  const casa = verified.reduce((s, a) => s + n(a.current_balance), 0);
  const inr = positions.filter(p => String(p.currency || 'INR').trim() === 'INR' && p.current_value != null);
  const eligible = inr.filter(p => !(p.record_type === 'FIXED_DEPOSIT' && p.metadata?.reconciliation_status === 'pending_reconciliation'));
  const sum = pred => eligible.filter(pred).reduce((s, p) => s + n(p.current_value), 0);
  const inv = p => p.category === 'INVESTMENT';
  const fd = sum(p => p.record_type === 'FIXED_DEPOSIT');
  const equity = sum(p => inv(p) && /^(EQUITY|STOCK|INDIAN_EQUITY|ETF)$/.test(p.record_type));
  const mutualFunds = sum(p => inv(p) && /^(MUTUAL_FUND|MF)$/.test(p.record_type));
  const gold = sum(p => inv(p) && /^(GOLD|DIGITAL_GOLD)$/.test(p.record_type));
  const silver = sum(p => inv(p) && /^(SILVER|DIGITAL_SILVER)$/.test(p.record_type));
  const pf = sum(p => inv(p) && /^(EPF|EPS|PROVIDENT_FUND|PF|PPF)$/.test(p.record_type));
  const us = positions.filter(p => /^(US_EQUITY|ETF)$/.test(String(p.record_type || '')) && String(p.currency || '').trim() === 'USD')
    .reduce((s, p) => s + usHoldingInrValue(p), 0);
  const liabilities = positions.filter(p => p.category === 'LIABILITY' && String(p.currency || 'INR').trim() === 'INR' && p.current_value != null)
    .reduce((s, p) => s + n(p.current_value), 0);
  const investments = equity + mutualFunds + gold + silver + fd + pf + us;
  return { casa, equity, mutualFunds, gold, silver, fd, pf, usPortfolioInr: us, investments, liabilities, total: casa + investments - liabilities };
}

// Comparison scopes: v1 field ↔ v2 category/subtype.
const SCOPES = [
  { scope: 'CASA', v1: 'casa', v2: a => a.category === 'CASA', kind: 'balance' },
  { scope: 'INVESTMENT/demat_equity', v1: 'equity', v2: a => a.subtype === 'demat_equity', kind: 'holdings' },
  { scope: 'INVESTMENT/mutual_fund', v1: 'mutualFunds', v2: a => a.subtype === 'mutual_fund', kind: 'holdings' },
  { scope: 'INVESTMENT/us_brokerage', v1: 'usPortfolioInr', v2: a => a.subtype === 'us_brokerage', kind: 'holdings' },
  { scope: 'INVESTMENT/digital_gold', v1: 'gold', v2: a => a.subtype === 'digital_gold', kind: 'holdings' },
  { scope: 'INVESTMENT/digital_silver', v1: 'silver', v2: a => a.subtype === 'digital_silver', kind: 'holdings' },
  { scope: 'INVESTMENT/fixed_deposit', v1: 'fd', v2: a => a.subtype === 'fixed_deposit', kind: 'balance' },
  { scope: 'INVESTMENT/provident_fund', v1: 'pf', v2: a => a.subtype === 'provident_fund', kind: 'balance' },
  { scope: 'LIABILITY', v1: 'liabilities', v2: a => a.category === 'LIABILITY', kind: 'balance' },
];

// reason: why a scope differs. 'excluded_in_v2' and 'price_basis' are explained differences;
// 'only_in_v1', 'only_in_v2' and 'value_differs' are unexplained and block the switch (TR2-D.2).
export function reconcile(v1, v2) {
  const differences = [];
  for (const s of SCOPES) {
    const accts = v2.accounts.filter(s.v2);
    const a = r2(v1[s.v1]);
    const b = r2(accts.reduce((sum, x) => sum + n(x.valueInr), 0));
    const diff = r2(b - a);
    if (Math.abs(diff) < 0.01) continue;
    const excluded = v2.totals.excluded.filter(e => accts.some(x => x.id === e.accountId));
    let reason;
    if (excluded.length) reason = 'excluded_in_v2';
    else if (a === 0) reason = 'only_in_v2';
    else if (b === 0) reason = 'only_in_v1';
    else if (s.kind === 'holdings') reason = 'price_basis';
    else reason = 'value_differs';
    differences.push({ scope: s.scope, v1: a, v2: b, difference: diff, reason,
      detail: excluded.length ? excluded.map(e => `${e.symbol || 'balance'}: ${e.reason}`).join(', ') : null });
  }
  const pick = t => ({ casa: r2(t.casa), investments: r2(t.investments), liabilities: r2(t.liabilities), netWorth: r2(t.total ?? t.netWorth) });
  return {
    v1: pick(v1),
    v2: pick(v2.totals),
    differences,
    acceptable: differences.every(d => ['excluded_in_v2', 'price_basis'].includes(d.reason)),
  };
}
