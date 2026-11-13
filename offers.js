// ---- Offers, earnings and rewards (2026-11-14) ----------------------------------------------------------------------------
// Loaded after app.js. A classic script: it shares app.js's globals ($, esc, money, api, accounts, items, activeView, renderView,
// loadDashboard, loadRewards, rwUnits, rwDay ...). Every name defined here starts with "of" / "OF_" so nothing clashes with app.js.
//
// What lives here
//   * the "Add / change offer" sheet (presets, a live sentence and example, progressive sections)   -> openOfferSheet()
//   * the Offers page                                                                            -> offersPageHtml(), loadOffers()
//   * "Waiting for review" on the Transactions page (Accept applies the offers by itself)        -> pendingTxHtml(), loadPendingTx()
//   * Rewards page parts: Add button, cashback on its way, "How you earn" per program, setup hints
//   * Transactions rows: the cashback / points an offer earned on a payment
// app.js calls these through ofCall(), so a failure here never breaks a page.

const OF_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const OF_CASH = ['cashback', 'discount', 'coupon'];
const OF_MODE_LABEL = { any: 'Any way of paying', upi: 'UPI', card: 'This card' };
const OF_PERIOD_WORD = { day: 'day', week: 'week', month: 'month', cycle: 'billing cycle', year: 'year' };
// Starting templates set the SHAPE of an offer only (what it is worked out from, how it is applied, how often). They never carry a rate,
// amount or limit: those are the real terms of your offer and you type them in (the example figures in the hints are only examples).
const OF_PRESETS = [
  { key: 'cashback_percent', icon: '%', title: '% cashback', hint: 'a percent of the payment back', fill: { rewardUnit: 'cashback', benefitType: 'percent' } },
  { key: 'cashback_flat', icon: '₹', title: 'Flat cashback', hint: 'a fixed amount back', fill: { rewardUnit: 'cashback', benefitType: 'flat' } },
  { key: 'points_block', icon: '★', title: 'Points per ₹', hint: 'points for every block of rupees', fill: { rewardUnit: 'points', benefitType: 'per_block' } },
  { key: 'points_percent', icon: '◎', title: 'Monies / points %', hint: 'a percent back as points', fill: { rewardUnit: 'monies', benefitType: 'percent' } },
  { key: 'spark', icon: '⚡', title: 'Spark style', hint: 'activate first · minimum · once', fill: { rewardUnit: 'cashback', benefitType: 'percent', frequency: 'one_time', applyMode: 'ask', paymentMode: 'upi' } },
  { key: 'one_time', icon: '1×', title: 'One-time offer', hint: 'welcome or first payment', fill: { rewardUnit: 'cashback', benefitType: 'flat', frequency: 'one_time' } },
  { key: 'upi', icon: 'UPI', title: 'UPI cashback', hint: 'on UPI payments', fill: { rewardUnit: 'cashback', benefitType: 'percent', paymentMode: 'upi' } },
  { key: 'monthly_cap', icon: '↻', title: 'Monthly cap', hint: 'a limit per billing cycle', fill: { rewardUnit: 'cashback', benefitType: 'percent', period: 'cycle' } },
];

// ---- small helpers --------------------------------------------------------------------------------------------------------
const ofIsCash = u => OF_CASH.includes(u);
const ofNum = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const ofR2 = n => Math.round(n * 100) / 100;
const ofRs = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
const ofUn = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ofDay = d => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const ofAcct = a => [a.bank_name, a.account_name].filter(Boolean).join(' · ') + (a.masked_identifier ? ' ' + a.masked_identifier : '');
const ofGroup = u => (u === 'cashback' ? 'cash' : u === 'discount' || u === 'coupon' ? 'off' : 'points');
const ofKindWord = u => (u === 'discount' ? 'off' : u === 'coupon' ? 'coupon' : 'cashback');
const ofDaysLeft = d => { if (!d) return null; const t = Date.parse(d + 'T23:59:59'); return Math.ceil((t - Date.now()) / 864e5); };
function ofErr(e) { return String((e && e.message) || e || 'Something went wrong'); }

// The program's unit word for points offers ("Monies", "Reward points", "points").
function ofUnitName(o, programs) {
  if (ofIsCash(o.reward_unit)) return ofKindWord(o.reward_unit);
  const p = (programs || []).find(x => x.id === o.program_id);
  return p ? p.unit : { coins: 'coins', monies: 'Monies' }[o.reward_unit] || 'points';
}

// ---- the sentence: "Get 5% cashback (up to ₹100 per payment) on payments to swiggy of ₹249 or more, paid by UPI." -------------
function ofGets(o, programs) {
  const cash = ofIsCash(o.reward_unit), v = Number(o.benefit_value), u = ofUnitName(o, programs);
  if (!(v > 0)) return 'a reward';
  if (o.benefit_type === 'percent') return cash ? v + '% ' + ofKindWord(o.reward_unit) : v + '% back as ' + u;
  if (o.benefit_type === 'flat') return cash ? ofRs(v) + ' ' + ofKindWord(o.reward_unit) : ofUn(v) + ' ' + u;
  const b = Number(o.block_amount);
  return (cash ? ofRs(v) + ' ' + ofKindWord(o.reward_unit) : ofUn(v) + ' ' + u) + ' per ' + (b > 0 ? ofRs(b) : '₹…');
}
function ofCapText(o, programs) {
  const cap = ofNum(o.max_benefit);
  return cap != null ? ' (up to ' + (ofIsCash(o.reward_unit) ? ofRs(cap) : ofUn(cap) + ' ' + ofUnitName(o, programs)) + ' per payment)' : '';
}
function ofWhereText(o) {
  const words = o.merchants || [], min = ofNum(o.min_spend), max = ofNum(o.max_spend);
  let s = words.length ? 'payments to ' + words.join(', ') : 'any payment';
  if (min != null && max != null) s += ' of ' + ofRs(min) + ' to ' + ofRs(max);
  else if (min != null && min > 0) s += ' of ' + ofRs(min) + ' or more';
  else if (max != null) s += ' of up to ' + ofRs(max);
  if (o.payment_mode === 'upi') s += ', paid by UPI';
  if (o.payment_mode === 'card') s += ', paid with this card';
  if ((o.weekdays || []).length) s += ', on ' + o.weekdays.map(i => OF_DAYS[i]).join(', ');
  return s;
}
function ofLimitsText(o, programs) {
  const out = [], unit = ofIsCash(o.reward_unit) ? v => ofRs(v) : v => ofUn(v) + ' ' + ofUnitName(o, programs);
  if (o.frequency === 'one_time') out.push('Once only');
  else if (o.frequency === 'limited' && ofNum(o.max_uses)) out.push('First ' + ofNum(o.max_uses) + ' time' + (ofNum(o.max_uses) === 1 ? '' : 's') + ' only');
  if (o.period && o.period !== 'none') {
    const w = [];
    if (ofNum(o.period_max_uses) != null) w.push(ofNum(o.period_max_uses) + ' time' + (ofNum(o.period_max_uses) === 1 ? '' : 's'));
    if (ofNum(o.period_max_benefit) != null) w.push('up to ' + unit(ofNum(o.period_max_benefit)));
    if (w.length) out.push(w.join(' and ') + ' per ' + OF_PERIOD_WORD[o.period] + (o.period === 'cycle' && ofNum(o.cycle_day) ? ' (statement day ' + ofNum(o.cycle_day) + ')' : ''));
  }
  return out;
}
function ofValidText(o) {
  if (o.valid_from && o.valid_to) return 'Valid ' + ofDay(o.valid_from) + ' – ' + ofDay(o.valid_to);
  if (o.valid_to) return 'Valid until ' + ofDay(o.valid_to);
  if (o.valid_from) return 'Valid from ' + ofDay(o.valid_from);
  return '';
}
// short = only what it gives and for which payments (cards show the limits and dates as chips next to it)
function ofSentence(o, programs, short) {
  const parts = ['Get ' + ofGets(o, programs) + ofCapText(o, programs) + ' on ' + ofWhereText(o) + '.'];
  if (short) return parts[0];
  const lim = ofLimitsText(o, programs).map(t => t.replace(/^./, c => c.toUpperCase())); if (lim.length) parts.push(lim.join('. ') + '.');
  const valid = ofValidText(o); if (valid) parts.push(valid + '.');
  if (o.apply_mode === 'ask') parts.push('You confirm each time (it must be activated first).');
  return parts.join(' ');
}
// Short chips for cards
function ofChips(o, programs) {
  const c = [];
  if (o.payment_mode === 'upi') c.push(['UPI', '']); if (o.payment_mode === 'card') c.push(['Card', '']);
  if (ofNum(o.min_spend)) c.push(['Min ' + ofRs(o.min_spend), '']); if (ofNum(o.max_spend)) c.push(['Max ' + ofRs(o.max_spend), '']);
  if ((o.weekdays || []).length) c.push([o.weekdays.map(i => OF_DAYS[i]).join(' '), '']);
  for (const t of ofLimitsText(o, programs)) c.push([t, '']);
  const left = ofDaysLeft(o.valid_to);
  if (o.valid_to) c.push([left < 0 ? 'Expired' : left === 0 ? 'Ends today' : left <= 14 ? 'Ends in ' + left + ' day' + (left === 1 ? '' : 's') : 'Until ' + ofDay(o.valid_to), left < 0 ? 'warn' : left <= 7 ? 'amber' : '']);
  else if (o.valid_from && ofDaysLeft(o.valid_from) > 0) c.push(['From ' + ofDay(o.valid_from), '']);
  if (o.coupon_code) c.push(['Code ' + o.coupon_code, '']);
  if (o.exclusive_group) c.push(['Best of “' + o.exclusive_group + '”', '']);
  if (o.apply_mode === 'ask') c.push(['Ask me', 'amber']);
  return c;
}
const ofChipsHtml = chips => (chips.length ? '<div class="of-chips">' + chips.map(([t, k]) => '<span class="of-chip ' + k + '">' + esc(t) + '</span>').join('') + '</div>' : '');

// What the offer gives on a payment of `amount` (mirrors computeEarning in api/_offers.js; a test keeps the two in step).
function ofCompute(o, amount, programs) {
  const a = Number(amount), v = Number(o.benefit_value), cash = ofIsCash(o.reward_unit), cap = ofNum(o.max_benefit);
  const prog = (programs || []).find(x => x.id === o.program_id), rate = prog && prog.inr_per_unit != null ? Number(prog.inr_per_unit) : null;
  let raw;
  if (o.benefit_type === 'per_block') { const b = Number(o.block_amount); if (!(b > 0)) return null; raw = Math.floor(a / b) * v; }
  else if (o.benefit_type === 'flat') raw = v;
  else if (cash) raw = a * v / 100;
  else { if (!(rate > 0)) return null; raw = (a * v / 100) / rate; }
  if (!(v > 0)) return null;
  return ofR2(cap != null ? Math.min(raw, cap) : raw);
}
function ofExampleText(o, amount, programs) {
  const a = Number(amount); if (!(a > 0)) return '';
  const min = ofNum(o.min_spend), max = ofNum(o.max_spend);
  if (min != null && a < min) return ofRs(a) + ' payment: not eligible (minimum ' + ofRs(min) + ')';
  if (max != null && a > max) return ofRs(a) + ' payment: not eligible (maximum ' + ofRs(max) + ')';
  const r = ofCompute(o, a, programs);
  if (r == null) return ofIsCash(o.reward_unit) ? '' : ofRs(a) + ' payment: pick the reward program first';
  return ofRs(a) + ' payment → ' + (ofIsCash(o.reward_unit) ? ofRs(r) + ' ' + ofKindWord(o.reward_unit) : ofUn(r) + ' ' + ofUnitName(o, programs));
}
function ofAutoTitle(f, programs) {
  const o = ofRowOf(f), words = f.merchants.slice(0, 2).join(', ');
  const t = ofGets(o, programs).replace(/^./, c => c.toUpperCase()) + (words ? ' · ' + words : '');
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

// ---- the form model -------------------------------------------------------------------------------------------------------
const ofBlank = accountId => ({ id: '', accountId: accountId || '', title: '', preset: '', rewardUnit: 'cashback', benefitType: 'percent', benefitValue: '', blockAmount: '', maxBenefit: '', programId: '',
  merchants: [], paymentMode: 'any', minSpend: '', maxSpend: '', weekdays: [], validFrom: '', validTo: '', frequency: 'unlimited', maxUses: '', period: 'none', periodMaxUses: '',
  periodMaxBenefit: '', cycleDay: '', applyMode: 'auto', couponCode: '', exclusiveGroup: '', verifyStatus: 'to_verify', sourceUrl: '', notes: '', lastCheckedOn: '', active: true });
const ofFromRow = o => ({ id: o.id, accountId: o.account_id, title: o.title, preset: o.preset || '', rewardUnit: o.reward_unit, benefitType: o.benefit_type, benefitValue: o.benefit_value,
  blockAmount: o.block_amount ?? '', maxBenefit: o.max_benefit ?? '', programId: o.program_id || '', merchants: [...(o.merchants || [])], paymentMode: o.payment_mode, minSpend: o.min_spend ?? '',
  maxSpend: o.max_spend ?? '', weekdays: [...(o.weekdays || [])], validFrom: o.valid_from || '', validTo: o.valid_to || '', frequency: o.frequency, maxUses: o.max_uses ?? '', period: o.period,
  periodMaxUses: o.period_max_uses ?? '', periodMaxBenefit: o.period_max_benefit ?? '', cycleDay: o.cycle_day ?? '', applyMode: o.apply_mode || 'auto', couponCode: o.coupon_code || '',
  exclusiveGroup: o.exclusive_group || '', verifyStatus: o.verify_status, sourceUrl: o.source_url || '', notes: o.notes || '', lastCheckedOn: o.last_checked_on || '', active: o.active });
// form -> the snake_case row the sentence / example functions read
const ofRowOf = f => ({ reward_unit: f.rewardUnit, benefit_type: f.benefitType, benefit_value: ofNum(f.benefitValue), block_amount: ofNum(f.blockAmount), max_benefit: ofNum(f.maxBenefit),
  program_id: f.programId || null, merchants: f.merchants, payment_mode: f.paymentMode, min_spend: ofNum(f.minSpend), max_spend: ofNum(f.maxSpend), weekdays: f.weekdays,
  valid_from: f.validFrom || null, valid_to: f.validTo || null, frequency: f.frequency, max_uses: ofNum(f.maxUses), period: f.period, period_max_uses: ofNum(f.periodMaxUses),
  period_max_benefit: ofNum(f.periodMaxBenefit), cycle_day: ofNum(f.cycleDay), apply_mode: f.applyMode, coupon_code: f.couponCode, exclusive_group: f.exclusiveGroup });

let ofSheet = null;     // {f, data, busy, err, open:{}, example, opener, dirty, newProg}

// ---- opening, closing, state ----------------------------------------------------------------------------------------------
async function openOfferSheet(opt = {}) {
  const opener = document.activeElement;
  let data;
  try { data = await api('/api/account-offers'); } catch (e) { alert(ofErr(e)); return; }
  let f;
  if (opt.offerId) { const o = data.offers.find(x => x.id === opt.offerId); if (!o) return; f = ofFromRow(o); }
  else if (opt.copyOf) { const o = data.offers.find(x => x.id === opt.copyOf); if (!o) return; f = ofFromRow(o); f.id = ''; f.title = o.title + ' (copy)'; f.verifyStatus = 'to_verify'; }
  else f = ofBlank(opt.accountId || (data.accounts.length === 1 ? data.accounts[0].id : ''));
  if (opt.programId) f.programId = opt.programId;
  ofSheet = { f, data, busy: false, err: '', open: { account: !f.accountId, gets: true, where: true, limits: !!(f.id && (f.frequency !== 'unlimited' || f.period !== 'none')), more: false }, example: 500, opener, dirty: false, newProg: null, preset: f.preset };
  if (opt.preset) ofApplyPreset(opt.preset);
  if (f.accountId) ofSyncProgram(true);
  ofRender();
  const first = document.querySelector('#offerOverlay [data-of="title"], #offerOverlay select[data-of="accountId"]'); if (first) first.focus();
}
function ofClose(force) {
  if (!ofSheet) return;
  if (!force && ofSheet.dirty && !confirm('Discard this offer? What you entered will be lost.')) return;
  const op = ofSheet.opener; ofSheet = null;
  const o = $('offerOverlay'); if (o) o.remove();
  document.body.classList.remove('sheet-open');
  if (op && op.focus && document.contains(op)) op.focus();
}
function ofApplyPreset(key) {
  const p = OF_PRESETS.find(x => x.key === key); if (!p || !ofSheet) return;
  const keep = { id: ofSheet.f.id, accountId: ofSheet.f.accountId, merchants: ofSheet.f.merchants, title: ofSheet.f.title, programId: ofSheet.f.programId, sourceUrl: ofSheet.f.sourceUrl, notes: ofSheet.f.notes };
  ofSheet.f = { ...ofBlank(keep.accountId), ...keep, preset: key, ...p.fill };
  ofSheet.preset = key; ofSheet.dirty = true;
  if (ofGroup(ofSheet.f.rewardUnit) === 'points') ofSyncProgram(true);
  ofSheet.open.limits = ofSheet.f.frequency !== 'unlimited' || ofSheet.f.period !== 'none';
  ofSheet.open.where = true;
}
// Points offers need a program: pick the one on this account when there is exactly one; set the unit word from its name.
function ofSyncProgram(auto) {
  const s = ofSheet, f = s.f; if (ofGroup(f.rewardUnit) !== 'points') return;
  const list = s.data.programs.filter(p => !f.accountId || p.account_id === f.accountId);
  if (auto && !f.programId && list.length === 1) f.programId = list[0].id;
  const p = s.data.programs.find(x => x.id === f.programId);
  if (p) f.rewardUnit = /monie/i.test(p.unit) ? 'monies' : /coin/i.test(p.unit) ? 'coins' : 'points';
}
function ofSet(k, v) {
  const s = ofSheet, f = s.f; f[k] = v; s.dirty = true;
  if (k === 'rewardGroup') {
    f.rewardUnit = v === 'cash' ? 'cashback' : v === 'off' ? 'discount' : 'points';
    if (v === 'points') ofSyncProgram(true); else f.programId = f.programId;
  }
  if (k === 'frequency' && v !== 'limited') f.maxUses = '';
  if (k === 'period' && v === 'none') { f.periodMaxUses = ''; f.periodMaxBenefit = ''; f.cycleDay = ''; }
  if (k === 'period' && v === 'cycle' && !f.cycleDay) f.cycleDay = 1;
  if (k === 'accountId') { f.programId = ''; ofSyncProgram(true); const a = s.data.accounts.find(x => x.id === v); if (f.paymentMode === 'card' && a && a.subtype_code !== 'credit_card') f.paymentMode = 'any'; }
  if (k === 'programId') ofSyncProgram(false);
}

// ---- rendering the sheet --------------------------------------------------------------------------------------------------
function ofSecHead(key, n, title, summary) {
  const open = ofSheet.open[key];
  return '<details class="ofs-sec" data-of-sec="' + key + '"' + (open ? ' open' : '') + '><summary><span class="ofs-num">' + n + '</span><b>' + esc(title) + '</b><small class="ofs-sum" data-of-sum="' + key + '">' + esc(summary) + '</small></summary><div class="ofs-fields">';
}
const ofSeg = (field, val, opts, extra = '') => '<div class="seg seg-wide ofs-seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-of-set="' + field + '" data-of-val="' + esc(v) + '"' + extra + ' class="' + (String(val) === String(v) ? 'active' : '') + '" aria-pressed="' + (String(val) === String(v)) + '">' + esc(l) + '</button>').join('') + '</div>';
const ofField = (label, inner, cls = '') => '<label class="ofs-f ' + cls + '"><span>' + esc(label) + '</span>' + inner + '</label>';
const ofInput = (field, val, attrs = '') => '<input data-of="' + field + '" value="' + esc(val ?? '') + '" ' + attrs + '>';

function ofSummaries() {
  const s = ofSheet, f = s.f, o = ofRowOf(f), P = s.data.programs, acc = s.data.accounts.find(a => a.id === f.accountId);
  return {
    account: acc ? ofAcct(acc) : 'Choose an account or card',
    gets: ofNum(f.benefitValue) ? ofGets(o, P) + ofCapText(o, P).replace(' (up to', ', up to').replace(' per payment)', ' per payment') : 'Not set yet',
    where: ofWhereText(o),
    limits: ofLimitsText(o, P).join(' · ') || 'No limits',
    more: [f.applyMode === 'ask' ? 'Ask me each time' : 'Applies by itself', f.couponCode ? 'code ' + f.couponCode : '', f.verifyStatus === 'verified' ? 'Verified' : 'To verify'].filter(Boolean).join(' · '),
  };
}
function ofSecAccount() {
  const s = ofSheet, f = s.f, sm = ofSummaries();
  const opts = s.data.accounts.map(a => '<option value="' + esc(a.id) + '"' + (a.id === f.accountId ? ' selected' : '') + '>' + esc(ofAcct(a)) + '</option>').join('');
  return ofSecHead('account', 1, 'Account or card', sm.account)
    + ofField('Which account gives this offer?', '<select data-of="accountId" data-of-struct required><option value="">Choose…</option>' + opts + '</select>')
    + '<p class="ofs-hint">Offers belong to the account the payment is made from, so they are found automatically when you accept a payment from it.</p></div></details>';
}
function ofSecGets() {
  const s = ofSheet, f = s.f, g = ofGroup(f.rewardUnit), cash = g !== 'points', progs = s.data.programs.filter(p => !f.accountId || p.account_id === f.accountId || p.id === f.programId);
  const unit = cash ? '₹' : (s.data.programs.find(p => p.id === f.programId) || {}).unit || 'points';
  let h = ofSecHead('gets', 2, 'What you get', ofSummaries().gets);
  h += '<div class="ofs-f"><span>Reward</span>' + ofSeg('rewardGroup', g, [['cash', 'Cashback'], ['points', 'Points'], ['off', 'Discount']]) + '</div>';
  if (!cash) {
    h += ofField('Reward program (where the points are kept)', '<select data-of="programId" data-of-struct><option value="">Choose…</option>' + progs.map(p => '<option value="' + esc(p.id) + '"' + (p.id === f.programId ? ' selected' : '') + '>' + esc(p.name + ' (' + p.unit + ')') + '</option>').join('') + '<option value="__new__">+ New program…</option></select>');
    if (s.newProg) h += ofNewProgramHtml();
  }
  h += '<div class="ofs-f"><span>How it is worked out</span>' + ofSeg('benefitType', f.benefitType, [['percent', '% of payment'], ['flat', cash ? 'Flat ₹' : 'Flat ' + unit], ['per_block', 'Per ₹ block']]) + '</div>';
  h += '<div class="ofs-row">';
  if (f.benefitType === 'percent') h += ofField(cash ? 'Percent back' : 'Percent of the payment, as value', '<span class="ofs-addon">' + ofInput('benefitValue', f.benefitValue, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="5"') + '<em>%</em></span>');
  else if (f.benefitType === 'flat') h += ofField(cash ? 'Amount' : 'How many ' + unit, '<span class="ofs-addon">' + (cash ? '<em>₹</em>' : '') + ofInput('benefitValue', f.benefitValue, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="50"') + (cash ? '' : '<em>' + esc(unit) + '</em>') + '</span>');
  else {
    h += ofField(cash ? 'Amount' : 'How many ' + unit, '<span class="ofs-addon">' + (cash ? '<em>₹</em>' : '') + ofInput('benefitValue', f.benefitValue, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="4"') + (cash ? '' : '<em>' + esc(unit) + '</em>') + '</span>');
    h += ofField('for every', '<span class="ofs-addon"><em>₹</em>' + ofInput('blockAmount', f.blockAmount, 'type="number" min="0" step="1" inputmode="decimal" placeholder="150"') + '</span>');
  }
  h += ofField('At most per payment (optional)', '<span class="ofs-addon">' + (cash ? '<em>₹</em>' : '') + ofInput('maxBenefit', f.maxBenefit, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="no limit"') + (cash ? '' : '<em>' + esc(unit) + '</em>') + '</span>');
  h += '</div>';
  if (!cash && f.benefitType === 'percent') { const p = s.data.programs.find(x => x.id === f.programId); if (p && !(Number(p.inr_per_unit) > 0)) h += '<p class="ofs-warn">This program has no ₹ value per point, so a percent cannot be worked out. Use “Per ₹ block” (for example 4 points per ₹150) or give the program a value.</p>'; }
  return h + '</div></details>';
}
function ofNewProgramHtml() {
  const n = ofSheet.newProg, acc = ofSheet.data.accounts.find(a => a.id === ofSheet.f.accountId);
  return '<div class="ofs-newprog"><b>New reward program</b><p class="ofs-hint">For points, coins or Monies you collect on ' + esc(acc ? ofAcct(acc) : 'this account') + '.</p>'
    + '<div class="ofs-row">' + ofField('Name', '<input data-of-np="name" value="' + esc(n.name) + '" placeholder="e.g. Slice Monies" maxlength="80">') + ofField('Unit', '<input data-of-np="unit" value="' + esc(n.unit) + '" placeholder="Monies, points, coins" maxlength="40">')
    + ofField('Worth in ₹ per unit (optional)', '<span class="ofs-addon"><em>₹</em><input data-of-np="rate" value="' + esc(n.rate) + '" type="number" min="0" step="0.0001" inputmode="decimal" placeholder="0.01"></span>') + '</div>'
    + '<div class="ofs-actions"><button type="button" class="primary" data-of-np-save' + (ofSheet.busy ? ' disabled' : '') + '>Create program</button><button type="button" class="ghost" data-of-np-cancel>Cancel</button></div>' + (n.err ? '<p class="split-err" role="alert">' + esc(n.err) + '</p>' : '') + '</div>';
}
function ofChipsInputHtml(f) {
  return '<div class="ofs-chipbox" data-of-chips>' + f.merchants.map(w => '<span class="ofs-chip">' + esc(w) + '<button type="button" data-of-chip-x="' + esc(w) + '" aria-label="Remove ' + esc(w) + '">×</button></span>').join('')
    + '<input data-of-chip-in placeholder="' + (f.merchants.length ? 'add another…' : 'e.g. swiggy, zepto — empty means any payee') + '" autocomplete="off" enterkeyhint="done"></div>';
}
function ofSecWhere() {
  const s = ofSheet, f = s.f, acc = s.data.accounts.find(a => a.id === f.accountId), isCard = !acc || acc.subtype_code === 'credit_card';
  let h = ofSecHead('where', 3, 'Which payments', ofSummaries().where);
  h += '<div class="ofs-f"><span>Paid to</span>' + ofChipsInputHtml(f) + '<small class="ofs-hint">We look for these words in the payment’s name or category. Leave empty for any payee.</small></div>';
  h += '<div class="ofs-f"><span>Paid with</span>' + ofSeg('paymentMode', f.paymentMode, [['any', 'Any way'], ['upi', 'UPI'], ['card', 'This credit card']].filter(([v]) => v !== 'card' || isCard)) + '</div>';
  h += '<div class="ofs-row">' + ofField('Payment of at least', '<span class="ofs-addon"><em>₹</em>' + ofInput('minSpend', f.minSpend, 'type="number" min="0" step="1" inputmode="decimal" placeholder="no minimum"') + '</span>')
    + ofField('Payment of at most', '<span class="ofs-addon"><em>₹</em>' + ofInput('maxSpend', f.maxSpend, 'type="number" min="0" step="1" inputmode="decimal" placeholder="no maximum"') + '</span>') + '</div>';
  h += '<div class="ofs-f"><span>Only on these days (none = every day)</span><div class="ofs-days">' + OF_DAYS.map((d, i) => '<button type="button" data-of-day="' + i + '" class="' + (f.weekdays.includes(i) ? 'on' : '') + '" aria-pressed="' + f.weekdays.includes(i) + '">' + d + '</button>').join('') + '</div></div>';
  h += '<div class="ofs-row">' + ofField('Valid from', ofInput('validFrom', f.validFrom, 'type="date"')) + ofField('Valid until', ofInput('validTo', f.validTo, 'type="date"')) + '</div>';
  return h + '</div></details>';
}
function ofSecLimits() {
  const s = ofSheet, f = s.f, cash = ofGroup(f.rewardUnit) !== 'points', unit = cash ? '₹' : (s.data.programs.find(p => p.id === f.programId) || {}).unit || 'points';
  let h = ofSecHead('limits', 4, 'Limits', ofSummaries().limits);
  h += '<div class="ofs-f"><span>How many times in total?</span>' + ofSeg('frequency', f.frequency, [['unlimited', 'Every time'], ['one_time', 'Once only'], ['limited', 'A set number']]) + '</div>';
  if (f.frequency === 'limited') h += ofField('Total number of uses', ofInput('maxUses', f.maxUses, 'type="number" min="1" step="1" inputmode="numeric" placeholder="3"'));
  h += ofField('Also limit per', '<select data-of="period" data-of-struct>' + [['none', 'No period limit'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['cycle', 'Billing cycle (card statement)'], ['year', 'Year']].map(([v, l]) => '<option value="' + v + '"' + (f.period === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>');
  if (f.period !== 'none') {
    h += '<div class="ofs-row">' + ofField('Uses in that period', ofInput('periodMaxUses', f.periodMaxUses, 'type="number" min="1" step="1" inputmode="numeric" placeholder="no limit"'))
      + ofField('Most you can earn in it', '<span class="ofs-addon">' + (cash ? '<em>₹</em>' : '') + ofInput('periodMaxBenefit', f.periodMaxBenefit, 'type="number" min="0" step="0.01" inputmode="decimal" placeholder="no limit"') + (cash ? '' : '<em>' + esc(unit) + '</em>') + '</span>')
      + (f.period === 'cycle' ? ofField('Statement day (1–28)', ofInput('cycleDay', f.cycleDay, 'type="number" min="1" max="28" step="1" inputmode="numeric" placeholder="10"')) : '') + '</div>';
    if (f.period === 'cycle') h += '<p class="ofs-hint">The billing cycle starts on the statement day of your card. A limit such as “₹1,500 per cycle” starts again each cycle.</p>';
  }
  return h + '</div></details>';
}
function ofSecMore() {
  const f = ofSheet.f;
  let h = ofSecHead('more', 5, 'How it works', ofSummaries().more);
  h += '<div class="ofs-f"><span>When a payment is accepted</span>' + ofSeg('applyMode', f.applyMode, [['auto', 'Apply it by itself'], ['ask', 'Ask me each time']]) + '<small class="ofs-hint">Choose “Ask me” for an offer you must activate first (like a Slice Spark): it stays switched off on the Accept screen until you turn it on.</small></div>';
  h += '<div class="ofs-row">' + ofField('Coupon code (if any)', ofInput('couponCode', f.couponCode, 'maxlength="40"')) + ofField('Group (only the best one applies)', ofInput('exclusiveGroup', f.exclusiveGroup, 'maxlength="40" placeholder="e.g. card tiers"')) + '</div>';
  h += '<p class="ofs-hint">Give offers of the same account the same group name when only one of them can apply to a payment — for example 10% on Swiggy, 5% online and 1% on everything else.</p>';
  h += ofField('Offer title', ofInput('title', f.title, 'maxlength="120" placeholder="' + esc(ofAutoTitle(f, ofSheet.data.programs)) + '"'));
  h += '<div class="ofs-f"><span>Is this offer confirmed?</span>' + ofSeg('verifyStatus', f.verifyStatus, [['to_verify', 'To verify'], ['verified', 'Verified']]) + '</div>';
  h += '<div class="ofs-row">' + ofField('Source link', ofInput('sourceUrl', f.sourceUrl, 'maxlength="300" placeholder="https://…"')) + ofField('Last checked', ofInput('lastCheckedOn', f.lastCheckedOn, 'type="date"')) + '</div>';
  h += ofField('Notes', ofInput('notes', f.notes, 'maxlength="300"'));
  h += '<label class="ofs-switch"><input type="checkbox" class="rm-switch" data-of-active' + (f.active ? ' checked' : '') + '> <span>Offer is on</span></label>';
  return h + '</div></details>';
}
function ofPresetsHtml() {
  return '<div class="ofs-presets"><div class="split-label">Start from</div><div class="ofs-pgrid">' + OF_PRESETS.map(p => '<button type="button" class="ofs-preset' + (ofSheet.preset === p.key ? ' on' : '') + '" data-of-preset="' + p.key + '"><i aria-hidden="true">' + esc(p.icon) + '</i><b>' + esc(p.title) + '</b><small>' + esc(p.hint) + '</small></button>').join('') + '</div></div>';
}
function ofFootHtml() {
  const s = ofSheet, o = ofRowOf(s.f), P = s.data.programs, ready = ofNum(s.f.benefitValue) > 0, ex = ofExampleText(o, s.example, P);
  return '<div class="ofs-live" aria-live="polite"><p class="ofs-sentence">' + (ready ? esc(ofSentence(o, P)) : 'Fill in what you get to see the offer in words.') + '</p>'
    + '<div class="ofs-example"><label>Try a payment of ₹<input data-of-example type="number" min="1" step="1" inputmode="decimal" value="' + esc(s.example) + '"></label><span data-of-example-out>' + esc(ready ? ex : '') + '</span></div></div>'
    + (s.err ? '<p class="split-err" role="alert">' + esc(s.err) + '</p>' : '')
    + '<div class="split-actions"><button type="button" class="ghost" data-of-cancel>Cancel</button><button type="button" class="primary" data-of-save' + (s.busy ? ' disabled' : '') + '>' + (s.busy ? 'Saving…' : s.f.id ? 'Save changes' : 'Add offer') + '</button></div>';
}
function ofRender() {
  const s = ofSheet; if (!s) return;
  let o = $('offerOverlay');
  if (!o) { o = document.createElement('div'); o.id = 'offerOverlay'; o.className = 'split-overlay'; document.body.appendChild(o); document.body.classList.add('sheet-open'); }
  const body = o.querySelector('.split-body'), top = body ? body.scrollTop : 0;
  o.innerHTML = '<div class="split-sheet ofs" role="dialog" aria-modal="true" aria-labelledby="ofsTitle"><div class="split-head"><div><span class="interest-kicker">' + (s.f.id ? 'CHANGE OFFER' : 'NEW OFFER') + '</span><h3 id="ofsTitle">' + (s.f.id ? 'Change offer' : 'Add an offer') + '</h3></div><button type="button" class="split-close" data-of-cancel aria-label="Close">×</button></div>'
    + '<div class="split-body">' + (s.f.id ? '' : ofPresetsHtml()) + ofSecAccount() + ofSecGets() + ofSecWhere() + ofSecLimits() + ofSecMore() + '</div>'
    + '<div class="split-foot ofs-foot" data-of-foot>' + ofFootHtml() + '</div></div>';
  const nb = o.querySelector('.split-body'); if (nb) nb.scrollTop = top;
}
// Update only what changes while typing (keeps focus): the section summaries and the live sentence.
function ofRefresh() {
  const o = $('offerOverlay'); if (!o || !ofSheet) return;
  const sm = ofSummaries(); for (const k of Object.keys(sm)) { const el = o.querySelector('[data-of-sum="' + k + '"]'); if (el) el.textContent = sm[k]; }
  const live = o.querySelector('.ofs-live'), s = ofSheet, row = ofRowOf(s.f), P = s.data.programs, ready = ofNum(s.f.benefitValue) > 0;
  if (live) { const sen = live.querySelector('.ofs-sentence'); if (sen) sen.textContent = ready ? ofSentence(row, P) : 'Fill in what you get to see the offer in words.'; const out = live.querySelector('[data-of-example-out]'); if (out) out.textContent = ready ? ofExampleText(row, s.example, P) : ''; }
  const t = o.querySelector('[data-of="title"]'); if (t && !t.value) t.placeholder = ofAutoTitle(s.f, P);
}
function ofRefreshChips() {
  const o = $('offerOverlay'), box = o && o.querySelector('[data-of-chips]'); if (!box) return;
  box.outerHTML = ofChipsInputHtml(ofSheet.f); const nb = o.querySelector('[data-of-chip-in]'); if (nb) nb.focus(); ofRefresh();
}
function ofAddChip(raw) {
  const s = ofSheet; if (!s) return false;
  const words = String(raw || '').split(/[,\n]/).map(x => x.trim().toLowerCase().slice(0, 40)).filter(Boolean); if (!words.length) return false;
  for (const w of words) if (!s.f.merchants.includes(w) && s.f.merchants.length < 10) s.f.merchants.push(w);
  s.dirty = true; return true;
}

// ---- saving ---------------------------------------------------------------------------------------------------------------
async function ofSave() {
  const s = ofSheet; if (!s || s.busy) return;
  const inp = document.querySelector('#offerOverlay [data-of-chip-in]'); if (inp && inp.value.trim()) { ofAddChip(inp.value); inp.value = ''; }
  const f = s.f;
  if (!f.accountId) { s.err = 'Choose the account or card this offer belongs to.'; s.open.account = true; ofRender(); return; }
  if (!(ofNum(f.benefitValue) > 0)) { s.err = 'Tell me what you get: enter the percent or the amount.'; s.open.gets = true; ofRender(); return; }
  if (ofGroup(f.rewardUnit) === 'points' && !f.programId) { s.err = 'Choose the reward program that keeps these points (or create one).'; s.open.gets = true; ofRender(); return; }
  s.busy = true; s.err = ''; ofRender();
  try {
    const body = { ...f, id: f.id || undefined, title: f.title.trim() || ofAutoTitle(f, s.data.programs), preset: f.preset || undefined };
    await api('/api/account-offers', { method: 'POST', body: JSON.stringify(body) });
    const adding = !f.id; ofClose(true); ofToast(adding ? 'Offer added. It is applied when you accept a matching payment.' : 'Offer saved.');
    await ofAfterChange();
  } catch (e) { s.busy = false; s.err = ofErr(e); ofRender(); }
}
async function ofCreateProgram() {
  const s = ofSheet, n = s.newProg; if (!s || !n || s.busy) return;
  const acc = s.data.accounts.find(a => a.id === s.f.accountId);
  if (!n.name.trim() || !n.unit.trim()) { n.err = 'Give the program a name and a unit (for example Monies).'; ofRender(); return; }
  if (!acc) { n.err = 'Choose the account first.'; ofRender(); return; }
  const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rate = ofNum(n.rate); s.busy = true; n.err = ''; ofRender();
  try {
    let r, key = slug(acc.bank_name + ' ' + n.name).slice(0, 56) || 'program';
    for (let i = 0; i < 4; i++) {
      try { r = await api('/api/rewards/programs', { method: 'POST', body: JSON.stringify({ programKey: i ? key + '-' + (i + 1) : key, provider: acc.bank_name, name: n.name.trim(), unit: n.unit.trim(), accountId: acc.id, ...(rate > 0 ? { inrPerUnit: rate, rateSource: 'Entered by me' } : {}) }) }); break; }
      catch (e) { if (!/already exists/i.test(ofErr(e)) || i === 3) throw e; }
    }
    s.data = await api('/api/account-offers'); s.f.programId = r.programId; s.newProg = null; s.dirty = true; ofSyncProgram(false);
  } catch (e) { n.err = ofErr(e); }
  s.busy = false; ofRender();
}
function ofToast(msg) { ofHost.msg = msg; }
const ofHost = { msg: '' };
// After an offer is added, changed or removed: refresh whichever page the owner is on.
async function ofAfterChange() {
  try { if (activeView === 'offers') await loadOffers(); else if (activeView === 'rewards') { await loadRewards(); } else if (activeView === 'transactions') await loadPendingTx(); } catch { }
}

// ---- events for the sheet -------------------------------------------------------------------------------------------------
document.addEventListener('click', e => {
  const s = ofSheet; if (!s) return;
  const o = $('offerOverlay'); if (!o || !o.contains(e.target)) return;
  const t = e.target;
  if (t.closest('[data-of-cancel]')) { ofClose(); return; }
  if (t === o) return;       // a tap beside the sheet never loses what was typed
  const pr = t.closest('[data-of-preset]'); if (pr) { ofApplyPreset(pr.dataset.ofPreset); ofRender(); return; }
  const st = t.closest('[data-of-set]'); if (st) { ofSet(st.dataset.ofSet, st.dataset.ofVal); ofRender(); return; }
  const dy = t.closest('[data-of-day]'); if (dy) { const i = Number(dy.dataset.ofDay), a = s.f.weekdays; s.f.weekdays = a.includes(i) ? a.filter(x => x !== i) : [...a, i].sort(); s.dirty = true; dy.classList.toggle('on'); dy.setAttribute('aria-pressed', String(s.f.weekdays.includes(i))); ofRefresh(); return; }
  const cx = t.closest('[data-of-chip-x]'); if (cx) { s.f.merchants = s.f.merchants.filter(w => w !== cx.dataset.ofChipX); s.dirty = true; ofRefreshChips(); return; }
  if (t.closest('[data-of-save]')) { ofSave(); return; }
  if (t.closest('[data-of-np-save]')) { ofCreateProgram(); return; }
  if (t.closest('[data-of-np-cancel]')) { s.newProg = null; ofRender(); return; }
});
document.addEventListener('input', e => {
  const s = ofSheet; if (!s || !$('offerOverlay') || !$('offerOverlay').contains(e.target)) return;
  const t = e.target;
  if (t.matches('[data-of-example]')) { s.example = t.value; ofRefresh(); return; }
  if (t.matches('[data-of-np]')) { s.newProg[t.dataset.ofNp] = t.value; return; }
  if (t.matches('[data-of]') && !t.hasAttribute('data-of-struct')) { s.f[t.dataset.of] = t.value; s.dirty = true; ofRefresh(); }
});
document.addEventListener('change', e => {
  const s = ofSheet; if (!s || !$('offerOverlay') || !$('offerOverlay').contains(e.target)) return;
  const t = e.target;
  if (t.matches('[data-of-active]')) { s.f.active = t.checked; s.dirty = true; return; }
  if (t.matches('[data-of][data-of-struct]')) {
    if (t.dataset.of === 'programId' && t.value === '__new__') { s.newProg = { name: '', unit: '', rate: '', err: '' }; ofRender(); const i = document.querySelector('#offerOverlay [data-of-np="name"]'); if (i) i.focus(); return; }
    ofSet(t.dataset.of, t.value); ofRender();
  }
});
document.addEventListener('keydown', e => {
  const s = ofSheet; if (!s) return;
  const o = $('offerOverlay'); if (!o) return;
  if (e.key === 'Escape') { e.preventDefault(); ofClose(); return; }
  if (e.target.matches && e.target.matches('[data-of-chip-in]')) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (ofAddChip(e.target.value)) { e.target.value = ''; ofRefreshChips(); } return; }
    if (e.key === 'Backspace' && !e.target.value && s.f.merchants.length) { s.f.merchants.pop(); s.dirty = true; ofRefreshChips(); return; }
  }
  if (e.key === 'Tab') {      // keep the focus inside the sheet
    const f = [...o.querySelectorAll('button:not([disabled]), input:not([disabled]), select, summary, a[href]')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
});
document.addEventListener('focusout', e => {      // a typed payee word is kept even when the field is left without Enter
  const s = ofSheet; if (!s || !e.target.matches || !e.target.matches('[data-of-chip-in]')) return;
  if (e.target.value.trim() && ofAddChip(e.target.value)) { e.target.value = ''; setTimeout(() => { const box = document.querySelector('#offerOverlay [data-of-chips]'); if (box && ofSheet) { box.outerHTML = ofChipsInputHtml(ofSheet.f); ofRefresh(); } }, 0); }
});
document.addEventListener('toggle', e => { const s = ofSheet, sec = e.target && e.target.dataset && e.target.dataset.ofSec; if (s && sec) s.open[sec] = e.target.open; }, true);
// Add buttons anywhere on the page
document.addEventListener('click', e => {
  const b = e.target.closest('[data-of-add]'); if (!b) return;
  openOfferSheet({ accountId: b.dataset.ofAccount || '', programId: b.dataset.ofProgram || '', preset: b.dataset.ofPreset || '' });
});

// ---- the Offers page ------------------------------------------------------------------------------------------------------
let ofPage = { data: null, filter: 'all', msg: '' };
function ofOfferCardHtml(o, programs) {
  const s = o.standing || {}, sentence = ofSentence(o, programs, true), left = [];
  if (s.usesLeftTotal != null) left.push(s.usesLeftTotal + ' use' + (s.usesLeftTotal === 1 ? '' : 's') + ' left');
  if (s.usesLeftPeriod != null) left.push(s.usesLeftPeriod + ' left this ' + OF_PERIOD_WORD[o.period]);
  if (s.benefitLeftPeriod != null) left.push((ofIsCash(o.reward_unit) ? ofRs(s.benefitLeftPeriod) : ofUn(s.benefitLeftPeriod)) + ' left this ' + OF_PERIOD_WORD[o.period]);
  const earned = o.uses_count ? 'Used ' + o.uses_count + ' time' + (o.uses_count === 1 ? '' : 's') + (o.earned_money ? ' · ' + ofRs(o.earned_money) + ' earned' : '') + (o.earned_units ? ' · ' + ofUn(o.earned_units) + ' ' + ofUnitName(o, programs) : '') : 'Not used yet';
  return '<article class="of-card' + (o.active ? '' : ' off') + '"><div class="of-card-top"><div class="of-card-title"><h4>' + esc(o.title) + '</h4>'
    + '<span class="of-badge ' + (o.verify_status === 'verified' ? 'ok' : 'tv') + '">' + (o.verify_status === 'verified' ? 'Verified' : 'To verify') + '</span>' + (o.active ? '' : '<span class="of-badge off">Off</span>') + (s.exhausted ? '<span class="of-badge warn">' + esc(s.exhausted) + '</span>' : '') + '</div></div>'
    + '<p class="of-sentence">' + esc(sentence) + '</p>' + ofChipsHtml(ofChips(o, programs))
    + '<p class="of-use">' + esc(earned) + (left.length ? ' · ' + esc(left.join(' · ')) : '') + '</p>'
    + (o.notes ? '<p class="of-note">' + esc(o.notes) + '</p>' : '') + (o.source_url ? '<p class="of-note"><a href="' + esc(o.source_url) + '" target="_blank" rel="noopener noreferrer">Source</a>' + (o.last_checked_on ? ' · checked ' + esc(ofDay(o.last_checked_on)) : '') + '</p>' : '')
    + '<div class="of-actions"><button type="button" class="ghost" data-of-edit="' + esc(o.id) + '">Edit</button><button type="button" class="ghost" data-of-copy="' + esc(o.id) + '">Duplicate</button>'
    + '<button type="button" class="ghost" data-of-toggle="' + esc(o.id) + '">' + (o.active ? 'Turn off' : 'Turn on') + '</button>' + (o.uses_count ? '<button type="button" class="ghost" data-of-undo="' + esc(o.id) + '">Undo last use</button>' : '')
    + '<button type="button" class="ghost danger" data-of-delete="' + esc(o.id) + '">Delete</button></div></article>';
}
function offersPageHtml() {
  const d = ofPage.data; if (!d) return '<section class="chart-card"><p class="muted">Loading offers…</p></section>';
  const f = ofPage.filter, all = d.offers, list = all.filter(o => f === 'all' || (f === 'active' && o.active) || (f === 'verify' && o.verify_status !== 'verified') || (f === 'off' && !o.active));
  const count = k => all.filter(o => k === 'all' || (k === 'active' && o.active) || (k === 'verify' && o.verify_status !== 'verified') || (k === 'off' && !o.active)).length;
  const head = '<section class="chart-card of-page"><div class="chart-head"><div><h4>Account offers</h4><p>The offers and earning rules of your accounts and cards. When you accept a payment, the ones that match are applied by themselves.</p></div><button type="button" class="primary" data-of-add>+ Add offer</button></div>'
    + (ofPage.msg ? '<p class="rm-msg" role="status">' + esc(ofPage.msg) + '</p>' : '');
  if (!all.length) return head + '<div class="of-empty"><b>No offers yet</b><p>Add how your card or account earns — cashback, points, a Spark, a one-time offer. Start from a template and change the numbers.</p><div class="of-empty-presets">'
    + OF_PRESETS.slice(0, 6).map(p => '<button type="button" class="ofs-preset" data-of-add data-of-preset="' + p.key + '"><i aria-hidden="true">' + esc(p.icon) + '</i><b>' + esc(p.title) + '</b><small>' + esc(p.hint) + '</small></button>').join('') + '</div></div></section>';
  const chips = '<div class="rw-chips" role="group" aria-label="Show">' + [['all', 'All'], ['active', 'On'], ['verify', 'To verify'], ['off', 'Off']].map(([k, l]) => '<button type="button" class="rec-chip' + (f === k ? ' active' : '') + '" data-of-filter="' + k + '" aria-pressed="' + (f === k) + '">' + l + ' <em>' + count(k) + '</em></button>').join('') + '</div>';
  const by = new Map(); for (const o of list) { if (!by.has(o.account_id)) by.set(o.account_id, { name: ofAcct(o), items: [] }); by.get(o.account_id).items.push(o); }
  return head + chips + ([...by.values()].map(g => '<h4 class="rm-group">' + esc(g.name) + '</h4><div class="of-grid">' + g.items.map(o => ofOfferCardHtml(o, d.programs)).join('') + '</div>').join('') || '<p class="muted">Nothing here.</p>') + '</section>';
}
function ofPageRender() { const b = $('offersBox'); if (b) b.innerHTML = offersPageHtml(); }
async function loadOffers() {
  try { ofPage.data = await api('/api/account-offers'); } catch (e) { const b = $('offersBox'); if (b) b.innerHTML = '<p class="error">' + esc(ofErr(e)) + '</p>'; return; }
  if (ofHost.msg) { ofPage.msg = ofHost.msg; ofHost.msg = ''; }
  ofPageRender();
}
function ofOfferPayload(o, over = {}) { return { ...ofFromRow(o), ...over }; }
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-of-filter],[data-of-edit],[data-of-copy],[data-of-toggle],[data-of-delete],[data-of-undo]'); if (!t || !$('offersBox')) return;
  const find = id => ofPage.data.offers.find(x => x.id === id);
  if (t.dataset.ofFilter) { ofPage.filter = t.dataset.ofFilter; ofPageRender(); return; }
  if (t.dataset.ofEdit) { openOfferSheet({ offerId: t.dataset.ofEdit }); return; }
  if (t.dataset.ofCopy) { openOfferSheet({ copyOf: t.dataset.ofCopy }); return; }
  try {
    if (t.dataset.ofToggle) { const o = find(t.dataset.ofToggle); await api('/api/account-offers', { method: 'POST', body: JSON.stringify(ofOfferPayload(o, { active: !o.active })) }); ofPage.msg = o.active ? 'Offer turned off.' : 'Offer turned on.'; }
    else if (t.dataset.ofUndo) { const o = find(t.dataset.ofUndo); if (!confirm('Undo the latest use of “' + o.title + '”? Its limits are counted again.')) return; await api('/api/account-offers', { method: 'POST', body: JSON.stringify({ action: 'undo_use', offerId: o.id }) }); ofPage.msg = 'Last use undone.'; }
    else if (t.dataset.ofDelete) { const o = find(t.dataset.ofDelete); if (!confirm('Delete “' + o.title + '”?\n\nWhat it already earned on your payments is kept.')) return; await api('/api/account-offers?id=' + encodeURIComponent(o.id), { method: 'DELETE' }); ofPage.msg = 'Offer deleted.'; }
    ofPage.data = await api('/api/account-offers');
  } catch (err) { ofPage.msg = ofErr(err); }
  ofPageRender();
});

// ---- Transactions page: "Waiting for review" -------------------------------------------------------------------------------
let ofPend = { items: [], msg: '', loaded: false };
function ofEarnText(m) {     // "+₹62.50 cashback" / "+3,000 Monies"
  return '+' + (m.kind === 'points' ? ofUn(m.amount) + ' ' + (m.programUnit || (m.unit === 'monies' ? 'Monies' : m.unit)) : ofRs(m.amount) + ' ' + ofKindWord(m.rewardUnit || m.unit));
}
function ofPendOfferHtml(m) {
  const on = m.apply === 'auto' && !m.shadowed, why = [];
  if (m.shadowed) why.push('Not applied — “' + m.shadowed + '” is better');
  else if (m.apply === 'ask') why.push('Needs activation in the app — turn on only if you used it');
  if (m.usesLeftPeriod != null) why.push(m.usesLeftPeriod + ' use' + (m.usesLeftPeriod === 1 ? '' : 's') + ' left this period');
  if (m.benefitLeftPeriod != null) why.push((m.kind === 'points' ? ofUn(m.benefitLeftPeriod) : ofRs(m.benefitLeftPeriod)) + ' left this period');
  if (m.oneTime) why.push('one-time offer');
  if (m.couponCode) why.push('code ' + m.couponCode);
  if (m.verifyStatus !== 'verified') why.push('to verify');
  return '<label class="pd-offer' + (m.shadowed ? ' dim' : '') + '"><input type="checkbox" class="rm-switch" data-of-apply="' + esc(m.id) + '"' + (on ? ' checked' : '') + (m.shadowed ? ' disabled' : '') + ' aria-label="Apply ' + esc(m.title) + '">'
    + '<span class="pd-offer-main"><b>' + esc(m.title) + '</b><small>' + esc(why.join(' · ')) + '</small></span>'
    + '<span class="pd-offer-amt"><b>' + esc(ofEarnText(m)) + '</b>' + (m.percent != null ? '<small>' + esc(String(m.percent)) + '% of the payment</small>' : '') + '</span></label>';
}
function ofPendItemHtml(t) {
  const into = t.kind === 'income' || (t.kind === 'transfer' && /received|from/i.test(t.category || '')), icon = t.kind === 'transfer' ? '⇄' : into ? '↓' : '↑', sign = into ? '+' : '−';
  const rewards = t.offers.length ? '<div class="pd-rewards"><div class="pd-rewards-head"><span aria-hidden="true">★</span> Rewards for this payment</div>' + t.offers.map(ofPendOfferHtml).join('') + '</div>' : '';
  return '<article class="pd-item" data-pd="' + esc(t.id) + '"><div class="pd-top"><span class="pd-icon ' + esc(t.kind) + '" aria-hidden="true">' + icon + '</span><div class="pd-main"><b>' + esc(t.description || t.category) + '</b><small>' + esc(t.category) + ' · ' + esc(ofDay(t.date)) + ' · ' + esc(t.account) + '</small></div><b class="pd-amt ' + esc(t.kind) + '">' + sign + esc(ofRs(t.amount)) + '</b></div>'
    + (t.cannot ? '<p class="pd-warn">' + esc(t.cannot) + '</p>' : '<p class="pd-balance">' + (t.owes ? 'Amount owed' : 'Balance') + ' ' + esc(money(t.balance)) + ' <span aria-hidden="true">→</span> <b>' + esc(money(t.after)) + '</b> <em>(' + (t.delta >= 0 ? '+' : '−') + esc(ofRs(Math.abs(t.delta))) + ')</em></p>')
    + rewards + '<div class="pd-actions">' + (t.cannot ? '' : '<button type="button" class="primary" data-tx-accept="' + esc(t.id) + '">Accept</button>') + '<button type="button" class="ghost" data-tx-dismiss="' + esc(t.id) + '">Dismiss</button></div></article>';
}
function pendingTxHtml() {
  const it = ofPend.items, msg = ofPend.msg; if (!it.length && !msg) return '';
  return '<section class="chart-card pd"><div class="chart-head"><div><h4>Waiting for review' + (it.length ? ' · ' + it.length : '') + '</h4><p>Accept a payment to update its account’s balance. The offers that match are applied by themselves; switch one off to skip it.</p></div></div>'
    + (msg ? '<div class="pd-msg" role="status">' + msg + '</div>' : '') + '<div class="pd-list">' + it.map(ofPendItemHtml).join('') + '</div></section>';
}
async function loadPendingTx() {
  try { ofPend.items = (await api('/api/transaction-accept')).pending || []; } catch { ofPend.items = []; }
  const b = $('pendingTx'); if (b) b.innerHTML = pendingTxHtml();
}
function ofAcceptMessage(r) {
  const parts = ['Accepted. Balance ' + esc(money(r.before)) + ' → <b>' + esc(money(r.after)) + '</b>.'];
  for (const a of r.applied || []) parts.push('<span class="pd-got">' + esc(ofEarnText({ ...a, rewardUnit: a.unit, kind: a.kind })) + '</span> from ' + esc(a.title) + (a.kind === 'points' ? '' : ' (expected)'));
  if (!(r.applied || []).length) parts.push((r.offers || []).length ? 'No offer applied.' : 'No offer matched this payment.');
  if (r.offerError) parts.push('<span class="error">Offers could not be applied: ' + esc(r.offerError) + '</span>');
  return parts.join(' ');
}
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-tx-accept],[data-tx-dismiss]'); if (!a) return;
  const id = a.dataset.txAccept || a.dataset.txDismiss, accept = !!a.dataset.txAccept, card = a.closest('.pd-item');
  const ids = accept && card ? [...card.querySelectorAll('[data-of-apply]:checked')].map(c => c.dataset.ofApply) : [];
  if (accept && !confirm('Accept this payment?\n\nThe balance of its account will be updated' + (ids.length ? ' and ' + ids.length + ' offer' + (ids.length === 1 ? '' : 's') + ' applied.' : '.'))) return;
  a.disabled = true;
  try {
    const r = await api('/api/transaction-accept', { method: 'POST', body: JSON.stringify({ action: accept ? 'accept' : 'dismiss', transactionId: id, applyOfferIds: accept ? ids : undefined }) });
    ofPend.msg = accept ? ofAcceptMessage(r) : 'Dismissed. The balance was not changed.';
    if (accept) { try { await loadDashboard(); } catch { } }
  } catch (err) { a.disabled = false; ofPend.msg = '<span class="error">' + esc(ofErr(err)) + '</span>'; }
  await loadPendingTx();
  if (activeView === 'transactions' && typeof activityRowsHtml === 'function') { try { activityRowsHtml(); } catch { } }
});

// ---- Rewards page parts ---------------------------------------------------------------------------------------------------
const ofProgramsOf = () => (typeof rewardsData !== 'undefined' && rewardsData && rewardsData.programs) || [];
function rewardsAddButtonHtml() { return '<button type="button" class="primary of-add" data-of-add>+ Add offer</button>'; }

// A short, plain line for one earning (also used on the Transactions page)
function ofEarnPill(e) {
  const money = e.kind === 'points' ? '+' + ofUn(e.units) + ' ' + (e.unit || 'points') : '+' + ofRs(e.inr) + ' ' + (e.kind === 'discount' ? 'saved' : e.kind === 'coupon' ? 'coupon' : 'cashback');
  const st = e.status === 'received' ? 'received' : e.kind === 'points' ? 'estimated' : e.kind === 'discount' ? 'saved' : 'expected';
  return money + (e.percent != null ? ' · ' + String(Number(e.percent)) + '%' : '') + ' · ' + st;
}
function ofEarnRowHtml(e, received) {
  const what = e.kind === 'points' ? '+' + ofUn(e.units) + ' ' + (e.unit || e.program_unit || 'points') : ofRs(e.inr);
  const pay = [e.tx_description, e.tx_amount != null ? ofRs(e.tx_amount) : '', ofDay(e.used_on), e.account].filter(Boolean).join(' · ');
  const sug = e.suggest ? '<div class="earn-suggest"><span aria-hidden="true">★</span> A credit of <b>' + esc(ofRs(e.suggest.amount)) + '</b> on ' + esc(ofDay(e.suggest.date)) + ' (' + esc(e.suggest.category || 'credit') + ') looks like this one.</div>' : '';
  const acts = received ? '<button type="button" class="ghost" data-earn-reopen="' + esc(e.id) + '">Reopen</button>'
    : (e.suggest ? '<button type="button" class="primary" data-earn-link="' + esc(e.id) + '" data-earn-credit="' + esc(e.suggest.transactionId) + '">Link &amp; mark received</button>' : '<button type="button" class="ghost" data-earn-receive="' + esc(e.id) + '">Mark received</button>')
      + '<button type="button" class="ghost danger" data-earn-remove="' + esc(e.id) + '">Remove</button>';
  return '<article class="earn-row"><div class="earn-main"><b>' + esc(what) + ' <em>' + esc(e.title || 'Offer') + '</em></b><small>' + esc(pay) + '</small>' + (received ? '<small class="earn-ok">Received' + (e.credited_on ? ' ' + esc(ofDay(e.credited_on)) : '') + (e.credited_transaction_id ? ' · linked to the credit' : '') + '</small>' : '') + sug + '</div><div class="earn-actions">' + acts + '</div></article>';
}
function rewardsEarningsHtml(d) {
  const all = (d.earnings || []).filter(e => e.kind !== 'points'), exp = all.filter(e => e.status === 'expected'), rec = all.filter(e => e.status === 'received').slice(0, 6);
  if (!exp.length && !rec.length) return '';
  const tot = d.earningTotals || {};
  return '<section class="chart-card earn"><div class="chart-head"><div><h4>Cashback on its way' + (exp.length ? ' · ' + ofRs(tot.money_expected || exp.reduce((n, e) => n + e.inr, 0)) : '') + '</h4><p>Worked out when you accepted the payment. Mark it received when the money arrives, or link the credit you imported.</p></div></div>'
    + (exp.length ? '<div class="earn-list">' + exp.map(e => ofEarnRowHtml(e, false)).join('') + '</div>' : '<p class="muted">Nothing is waiting for a credit.</p>')
    + (rec.length ? '<details class="rw-cats"><summary>Received (' + rec.length + (tot.money_received ? ' · ' + ofRs(tot.money_received) : '') + ')</summary><div class="earn-list">' + rec.map(e => ofEarnRowHtml(e, true)).join('') + '</div></details>' : '') + '</section>';
}
// The "set up your accounts" hint can be hidden for good (kept in this browser only).
function ofSetupHidden() { try { return localStorage.getItem('wealth.ofSetupHidden') === '1'; } catch { return false; } }
document.addEventListener('click', e => { if (!e.target.closest('[data-of-setup-hide]')) return; try { localStorage.setItem('wealth.ofSetupHidden', '1'); } catch { } const s = e.target.closest('.of-setup'); if (s) s.remove(); });
function rewardsSetupHtml(d) {
  const have = new Set((d.offers || []).map(o => o.account_id));
  const list = (typeof accounts !== 'undefined' && Array.isArray(accounts) ? accounts : []).filter(a => a.id && ['credit_card', 'savings', 'current'].includes(a.account_type) && !have.has(a.id));
  if (!list.length || ofSetupHidden()) return '';
  return '<section class="of-setup"><button type="button" class="of-setup-x" data-of-setup-hide aria-label="Hide this suggestion" title="Hide">×</button><div><b>Set up earning for your accounts</b><p>Add the cashback, points or offers of an account, and payments from it earn by themselves when you accept them.</p></div><div class="of-setup-chips">'
    + list.slice(0, 8).map(a => '<button type="button" class="of-setup-chip" data-of-add data-of-account="' + esc(a.id) + '">+ ' + esc(ofAcct(a)) + '</button>').join('') + '</div></section>';
}
function ofRuleHtml(o, programs) {
  return '<li class="of-rule' + (o.active ? '' : ' off') + '"><div class="of-rule-main"><div class="of-rule-title"><b>' + esc(o.title) + '</b>' + (o.verify_status === 'verified' ? '' : '<span class="of-badge tv">To verify</span>') + (o.active ? '' : '<span class="of-badge off">Off</span>') + '</div>'
    + '<small>' + esc(ofSentence(o, programs, true)) + '</small></div><button type="button" class="link-btn" data-of-open="' + esc(o.id) + '">Edit</button></li>';
}
function rewardEarnHtml(p) {
  const offers = p.offers || [], e = p.earned || {}, programs = ofProgramsOf(), cash = p.inr_per_unit == null && !!p.cash_match;
  const preset = cash ? 'cashback_percent' : Number(p.inr_per_unit) > 0 ? 'points_percent' : 'points_block';
  const add = '<button type="button" class="link-btn" data-of-add data-of-account="' + esc(p.account_id || '') + '" data-of-program="' + (cash ? '' : esc(p.id)) + '" data-of-preset="' + preset + '">+ Add rule</button>';
  const earned = e.units > 0 ? '<div class="of-earned"><b>+' + esc(ofUn(e.units)) + ' ' + esc(p.unit) + '</b> from offers on ' + e.count + ' payment' + (e.count === 1 ? '' : 's') + (e.since ? ' since your balance on ' + esc(ofDay(e.since)) : '')
    + '<small>An estimate' + (e.estimatedValue != null ? ' (≈ ' + esc(ofRs(e.units * Number(p.inr_per_unit))) + ')' : '') + ' that counts only what your offers earned. Your next recorded balance replaces it.</small></div>' : '';
  return '<div class="of-earn"><div class="of-earn-head"><b>How you earn</b>' + add + '</div>' + earned
    + (offers.length ? '<ul class="of-rules">' + offers.map(o => ofRuleHtml(o, programs)).join('') + '</ul>' : '<p class="of-earn-empty">No earning rule yet. Add how this earns, and accepted payments earn by themselves.</p>') + '</div>';
}
function rewardsOtherOffersHtml(d) {
  const list = d.otherOffers || []; if (!list.length) return '';
  const programs = ofProgramsOf();
  return '<section class="chart-card"><div class="chart-head"><div><h4>Offers on other accounts</h4><p>Offers of accounts that have no reward program.</p></div><button type="button" class="ghost" data-view="offers">Manage all offers →</button></div><ul class="of-rules">'
    + list.map(o => ofRuleHtml(o, programs).replace('<b>' + esc(o.title) + '</b>', () => '<b>' + esc(o.title) + '</b> <span class="of-acct">' + esc(ofAcct(o)) + '</span>')).join('') + '</ul></section>';
}
document.addEventListener('click', e => { const b = e.target.closest('[data-of-open]'); if (b) openOfferSheet({ offerId: b.dataset.ofOpen }); });

// ---- cashback to receive: mark received / link the credit / remove / reopen; and "check offers" on a payment -----------------
async function ofEarnAction(body) {
  await api('/api/offer-earnings', { method: 'POST', body: JSON.stringify(body) });
  try { await loadDashboard(); } catch { }
  if (activeView === 'rewards') await loadRewards(); else if (activeView === 'transactions') renderView('transactions');
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-earn-receive],[data-earn-link],[data-earn-remove],[data-earn-reopen],[data-tx-apply-offers]'); if (!t) return;
  try {
    t.disabled = true;
    if (t.dataset.earnLink) await ofEarnAction({ action: 'received', earningId: t.dataset.earnLink, creditedTransactionId: t.dataset.earnCredit });
    else if (t.dataset.earnReceive) await ofEarnAction({ action: 'received', earningId: t.dataset.earnReceive });
    else if (t.dataset.earnReopen) await ofEarnAction({ action: 'expected', earningId: t.dataset.earnReopen });
    else if (t.dataset.earnRemove) { if (!confirm('Remove this reward?\n\nIt stops counting toward the offer limits. The payment itself is not changed.')) { t.disabled = false; return; } await ofEarnAction({ action: 'cancel', earningId: t.dataset.earnRemove }); }
    else if (t.dataset.txApplyOffers) {
      const r = await api('/api/transaction-accept', { method: 'POST', body: JSON.stringify({ action: 'apply_offers', transactionId: t.dataset.txApplyOffers }) });
      try { await loadDashboard(); } catch { }
      if (!(r.applied || []).length) { t.disabled = false; alert((r.offers || []).length ? 'The matching offers need activation. Accept payments with the offer switched on, or edit the offer to apply by itself.' : 'No offer matches this payment.'); return; }
      if (activeView === 'transactions') renderView('transactions');
    }
  } catch (err) { t.disabled = false; alert(ofErr(err)); }
});

// ---- Transactions rows: what an offer earned on a payment -----------------------------------------------------------------
function rewardRowTag(x) {
  const r = x.rewards || []; if (!r.length) return '';
  return '<span class="of-txtags">' + r.map(e => '<em class="act-tag reward ' + esc(e.status) + (e.kind === 'points' ? ' pts' : '') + '" title="' + esc(e.title || 'Offer') + '">★ ' + esc(ofEarnPill(e)) + '</em>').join('') + '</span>';
}
function rewardRowDetail(x) {
  const r = x.rewards || [];
  if (!r.length) return (['expense', 'investment'].includes(x.kind) && x.account_id) ? '<div class="of-txdetail"><button type="button" class="link-btn" data-tx-apply-offers="' + esc(x.id) + '">Check offers for this payment</button></div>' : '';
  return '<div class="of-txdetail"><div class="of-txdetail-head">Rewards</div>' + r.map(e => '<div class="of-txline"><span><b>' + esc(e.title || 'Offer') + '</b><small>' + esc(ofEarnPill(e)) + '</small></span><span class="of-txline-btns">'
    + (e.kind !== 'points' && e.status === 'expected' ? '<button type="button" class="link-btn" data-earn-receive="' + esc(e.id) + '">Mark received</button>' : '')
    + (e.status === 'received' ? '<button type="button" class="link-btn" data-earn-reopen="' + esc(e.id) + '">Reopen</button>' : '')
    + '<button type="button" class="link-btn" data-earn-remove="' + esc(e.id) + '">Remove</button></span></div>').join('') + '</div>';
}
