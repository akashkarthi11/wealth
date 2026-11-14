// ---- Interest on your accounts (2026-11-14) ----------------------------------------------------------------------------------
// Loaded after app.js and offers.js (classic script, shares their globals: $, esc, money, api, loadDashboard, loadInterestSources ...).
// Every name here starts with "in" / "IN_" so nothing clashes. app.js calls inSourcesHtml() through ofCall().
//   * the Interest page's "Interest on your accounts" list: rate, how it is paid, this period so far, next payment, balance, history
//   * the "Interest on an account" sheet: account, rate per year, paid every day / month / 2 months / 3 / 6 / 12 months, period start
const IN_FREQ = [['daily', 'Every day'], ['monthly', 'Every month'], ['bimonthly', 'Every 2 months'], ['quarterly', 'Every 3 months'], ['half_yearly', 'Every 6 months'], ['yearly', 'Every year']];
const IN_FREQ_WORD = { daily: 'paid daily', monthly: 'paid monthly', bimonthly: 'paid every 2 months', quarterly: 'paid quarterly', half_yearly: 'paid every 6 months', yearly: 'paid yearly', on_maturity: 'paid at maturity' };
const IN_MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, half_yearly: 6, yearly: 12 };
const inRs = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inDay = d => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const inPct = r => (r == null ? '—' : (Math.round(Number(r) * 1e6) / 1e4).toLocaleString('en-IN', { maximumFractionDigits: 4 }) + '%');
const inAcct = a => [a.bank_name, a.account_name].filter(Boolean).join(' · ') + (a.masked_identifier ? ' ' + a.masked_identifier : '');
let inData = null, inSheet = null;

// ---- the list on the Interest page ----------------------------------------------------------------------------------------
function inSourceHtml(s) {
  const fd = s.subtype_code === 'fixed_deposit', paid = IN_FREQ_WORD[s.credit_frequency] || (fd ? 'deposit terms' : 'not paid into the account');
  const lines = [];
  if (s.paused) lines.push('<span class="in-tag off">Paused</span> Nothing is worked out until you turn it back on.');
  else if (s.credit_frequency === 'daily') lines.push('This month so far <b>' + esc(inRs(s.accrued_month)) + '</b> · added to the balance every day · ' + (s.record_mode === 'day' ? 'a new entry every day' : 'one entry for the month'));
  else if (s.next_credit) lines.push('This period so far <b>' + esc(inRs(s.period_accrued)) + '</b> · paid on <b>' + esc(inDay(s.next_credit)) + '</b>' + (s.period ? ' <small>(' + esc(inDay(s.period.start)) + ' – ' + esc(inDay(s.period.end)) + ')</small>' : ''));
  else lines.push('This month so far <b>' + esc(inRs(s.accrued_month)) + '</b>');
  if (s.balance != null) lines.push('Balance ' + esc(inRs(s.balance)) + (s.balance_as_of ? ' <small>as of ' + esc(inDay(new Date(new Date(s.balance_as_of).getTime() + 5.5 * 3600e3).toISOString())) + '</small>' : ''));
  lines.push('<small>Last worked out ' + esc(s.last_accrual ? inDay(s.last_accrual) : 'not yet') + ' · paid so far ' + esc(inRs(s.credited_total)) + (fd ? '' : ' · uses a balance up to ' + esc(String(s.max_age_days)) + ' days old') + '</small>');
  if (fd && !s.fd_principal) lines.push('<small class="in-warn">Deposit terms are missing: add them on the account to work the interest out.</small>');
  const editable = !fd;
  return '<article class="in-card' + (s.paused ? ' off' : '') + '"><div class="in-card-top"><div><h4>' + esc(inAcct(s)) + '</h4><small>' + esc(inPct(s.rate)) + ' a year' + (s.own ? '' : ' · bank rate') + ' · ' + esc(paid) + (s.rate_from ? ' · rate since ' + esc(inDay(s.rate_from)) : '') + '</small></div>'
    + '<b class="in-amt">' + esc(inRs(s.credit_frequency && IN_MONTHS[s.credit_frequency] ? s.period_accrued : s.accrued_month)) + '</b></div>'
    + '<div class="in-lines">' + lines.map(l => '<p>' + l + '</p>').join('') + '</div>'
    + (editable ? '<div class="in-actions"><button type="button" class="ghost" data-in-edit="' + esc(s.account_id) + '">Edit</button><button type="button" class="ghost" data-in-pause="' + esc(s.account_id) + '">' + (s.paused ? 'Turn on' : 'Pause') + '</button></div>' : '') + '</article>';
}
function inSourcesHtml(d) {
  inData = d;
  const ready = d.unlinked.filter(u => ['savings', 'current'].includes(u.subtype_code));
  const head = '<section class="chart-card in-page"><div class="chart-head"><div><h4>Interest on your accounts</h4><p>Your rate per year and how the bank pays it. The app works the interest out every night from the latest balance, lists it, and adds it to the balance when it is paid.</p></div><button type="button" class="primary in-add" data-in-add>+ Add account</button></div>';
  const cards = d.sources.length ? '<div class="in-grid">' + d.sources.map(inSourceHtml).join('') + '</div>' : '<p class="muted">No account earns interest here yet. Add a savings account with its rate per year.</p>';
  const setup = ready.length ? '<div class="in-setup"><span>Not set up yet:</span>' + ready.map(u => '<button type="button" class="of-setup-chip" data-in-add data-in-account="' + esc(u.id) + '">+ ' + esc(inAcct(u)) + '</button>').join('') + '</div>' : '';
  const hist = (d.history || []).length ? '<div id="inHist">' + inHistInner() + '</div>' : '';
  return head + cards + setup + hist + '</section>';
}

// ---- the sheet ------------------------------------------------------------------------------------------------------------
async function inOpen(accountId) {
  if (!inData) { try { inData = await api('/api/interest'); } catch (e) { alert(String((e && e.message) || e)); return; } }
  const opener = document.activeElement, src = inData.sources.find(s => s.account_id === accountId);
  const first = d => d.slice(0, 8) + '01', today = inData.today || new Date().toISOString().slice(0, 10);
  inSheet = { opener, editing: !!src, own: src ? !!src.own : true, today, f: {
    accountId: accountId || '', ratePercent: src && src.rate != null ? String(Math.round(src.rate * 1e8) / 1e6) : '', creditFrequency: src ? (src.credit_frequency && IN_FREQ_WORD[src.credit_frequency] && src.credit_frequency !== 'on_maturity' ? src.credit_frequency : 'monthly') : 'monthly',
    recordMode: src && src.record_mode === 'day' ? 'day' : 'month',
    creditAnchor: src && src.credit_anchor ? src.credit_anchor : first(today), effectiveFrom: today, balanceMaxAgeDays: src ? String(src.max_age_days || '') : String(inData.ownMaxAgeDays || 60), paused: src ? !!src.paused : false },
    origRate: src && src.rate != null ? Math.round(src.rate * 1e8) / 1e6 : null, err: '', busy: false };
  inRender();
  const f = document.querySelector('#interestOverlay select:not([disabled]), #interestOverlay input:not([disabled])'); if (f) f.focus();
}
function inClose() { const o = $('interestOverlay'); if (o) o.remove(); document.body.classList.remove('sheet-open'); const op = inSheet && inSheet.opener; inSheet = null; if (op && op.focus && document.contains(op)) op.focus(); }
// The end of the period that holds `day` (for the "next payment" line), counted from the period start.
function inNextPay(anchor, months, day) {
  if (!anchor || !months || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null;
  const add = (d, n) => { const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, dd = +d.slice(8, 10), yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12, last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate(); return new Date(Date.UTC(yy, mm, Math.min(dd, last))).toISOString().slice(0, 10); };
  let i = 0; while (add(anchor, (i + 1) * months) <= day && i < 600) i++;
  const end = new Date(Date.parse(add(anchor, (i + 1) * months) + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  return end < day ? null : end;
}
// One plain sentence about the whole setup, shown at the bottom of the sheet while choosing.
function inExample() {
  const s = inSheet, f = s.f, pct = Number(f.ratePercent);
  if (!(pct > 0)) return 'Enter the rate per year to see what it earns.';
  const day = 100000 * pct / 100 / 365, months = IN_MONTHS[f.creditFrequency];
  if (f.creditFrequency === 'daily') return 'On ₹1,00,000: about ' + inRs(day) + ' a day, added to the balance every day, shown as ' + (f.recordMode === 'day' ? 'a new entry every day.' : 'one entry for the month that grows every night.');
  const next = inNextPay(f.creditAnchor, months, s.today);
  return 'On ₹1,00,000: about ' + inRs(day) + ' a day; about ' + inRs(day * 30.4 * months) + ' is paid into the balance every ' + (months === 1 ? 'month' : months + ' months') + (next ? ', next on ' + inDay(next) : '') + '.';
}
const IN_FREQ_HINT = { daily: 'Added every day · Slice, Atom', monthly: 'At each month end', bimonthly: 'Once in 2 months', quarterly: 'Most banks · 4 times a year', half_yearly: 'Twice a year', yearly: 'Once a year' };
function inRender() {
  const s = inSheet; if (!s) return;
  let o = $('interestOverlay');
  if (!o) { o = document.createElement('div'); o.id = 'interestOverlay'; o.className = 'split-overlay'; document.body.appendChild(o); document.body.classList.add('sheet-open'); }
  const body = o.querySelector('.split-body'), top = body ? body.scrollTop : 0;
  const f = s.f, accts = [...inData.sources.filter(x => x.subtype_code !== 'fixed_deposit').map(x => ({ id: x.account_id, label: inAcct(x) })), ...inData.unlinked.filter(u => ['savings', 'current'].includes(u.subtype_code)).map(u => ({ id: u.id, label: inAcct(u) }))];
  const rateChanged = s.editing && s.own && s.origRate != null && Number(f.ratePercent) !== s.origRate;
  const step = (n, title, inner) => '<section class="in-step"><h4><span class="ofs-num">' + n + '</span>' + esc(title) + '</h4>' + inner + '</section>';
  const freq = '<div class="in-opts" role="radiogroup" aria-label="When the bank pays the interest">' + IN_FREQ.map(([v, l]) => '<button type="button" role="radio" class="in-opt' + (f.creditFrequency === v ? ' on' : '') + '" data-in-freq="' + v + '" aria-checked="' + (f.creditFrequency === v) + '"><b>' + esc(l) + '</b><small>' + esc(IN_FREQ_HINT[v]) + '</small></button>').join('') + '</div>';
  const pct = Number(f.ratePercent) > 0 ? Number(f.ratePercent) : 5.5, perDay = inRs(100000 * pct / 100 / 365), month = new Date((s.today || '2026-11-14') + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short' });
  const d = n => new Date(Date.parse((s.today || '2026-11-14') + 'T00:00:00Z') - n * 864e5).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const record = f.creditFrequency === 'daily'
    ? '<div class="in-opts in-opts-2" role="radiogroup" aria-label="How the daily interest shows in Transactions">'
      + '<button type="button" role="radio" class="in-opt in-rec' + (f.recordMode === 'month' ? ' on' : '') + '" data-in-rec="month" aria-checked="' + (f.recordMode === 'month') + '"><b>One entry for the month</b><small>Grows every night, like Slice does today</small>'
      + '<span class="in-mock"><span><i>' + esc(month) + ' interest · to date</i><em>' + esc(inRs(100000 * pct / 100 / 365 * 13)) + '</em></span><span class="in-mock-note">↻ updated each night</span></span></button>'
      + '<button type="button" role="radio" class="in-opt in-rec' + (f.recordMode === 'day' ? ' on' : '') + '" data-in-rec="day" aria-checked="' + (f.recordMode === 'day') + '"><b>A new entry every day</b><small>One small entry for each day</small>'
      + '<span class="in-mock"><span><i>Interest · ' + esc(d(1)) + '</i><em>' + esc(perDay) + '</em></span><span><i>Interest · ' + esc(d(2)) + '</i><em>' + esc(perDay) + '</em></span><span><i>Interest · ' + esc(d(3)) + '</i><em>' + esc(perDay) + '</em></span></span></button></div>'
    : '<label class="ofs-f"><span>A period starts on</span><input data-in="creditAnchor" type="date" value="' + esc(f.creditAnchor) + '"><small class="ofs-hint">The interest is paid at the end of each period and added to the balance' + (inNextPay(f.creditAnchor, IN_MONTHS[f.creditFrequency], s.today) ? ' — next on <b>' + esc(inDay(inNextPay(f.creditAnchor, IN_MONTHS[f.creditFrequency], s.today))) + '</b>' : '') + '. Quarters ending March, June, September and December start on 1 January.</small></label>'
      + '<div class="in-mock in-mock-wide"><span><i>Interest paid · end of period</i><em>one entry each time</em></span></div>';
  o.innerHTML = '<div class="split-sheet ofs in-sheet" role="dialog" aria-modal="true" aria-labelledby="inTitle"><div class="split-head"><div><span class="interest-kicker">INTEREST</span><h3 id="inTitle">' + (s.editing ? 'Interest on this account' : 'Add an account that earns interest') + '</h3></div><button type="button" class="split-close" data-in-cancel aria-label="Close">×</button></div>'
    + '<div class="split-body">'
    + step(1, 'Account and rate', '<div class="ofs-row"><label class="ofs-f"><span>Account</span><select data-in="accountId"' + (s.editing ? ' disabled' : '') + '><option value="">Choose…</option>' + accts.map(a => '<option value="' + esc(a.id) + '"' + (a.id === f.accountId ? ' selected' : '') + '>' + esc(a.label) + '</option>').join('') + '</select></label>'
      + '<label class="ofs-f"><span>Interest rate per year</span><span class="ofs-addon in-rate"><input data-in="ratePercent" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="' + esc(f.ratePercent) + '" placeholder="e.g. 6.5"' + (s.own ? '' : ' disabled') + '><em>% a year</em></span></label></div>'
      + (s.own ? '' : '<p class="ofs-hint">This account follows the bank\'s published rate, kept up to date for you. You can still choose how the interest is paid and shown.</p>')
      + (rateChanged ? '<label class="ofs-f"><span>The new rate starts on</span><input data-in="effectiveFrom" type="date" value="' + esc(f.effectiveFrom) + '"><small class="ofs-hint">Days before this keep the old rate.</small></label>' : ''))
    + step(2, 'When does the bank pay it?', freq)
    + step(3, f.creditFrequency === 'daily' ? 'How should it show in Transactions?' : 'When does a period start?', record)
    + '<details class="in-adv"><summary>More settings</summary><label class="ofs-f"><span>Use a balance up to … days old</span><span class="ofs-addon"><input data-in="balanceMaxAgeDays" type="number" min="1" max="120" step="1" inputmode="numeric" value="' + esc(f.balanceMaxAgeDays) + '"><em>days</em></span><small class="ofs-hint">Interest is worked out from the latest balance you recorded or that an accepted payment left. An older balance is not used.</small></label>'
    + '<label class="ofs-switch"><input type="checkbox" class="rm-switch" data-in-paused' + (f.paused ? ' checked' : '') + '> <span>Paused — nothing is worked out until turned back on</span></label></details>'
    + '</div><div class="split-foot ofs-foot"><p class="ofs-sentence" data-in-example>' + esc(inExample()) + '</p>' + (s.err ? '<p class="split-err" role="alert">' + esc(s.err) + '</p>' : '')
    + '<div class="split-actions"><button type="button" class="ghost" data-in-cancel>Cancel</button><button type="button" class="primary" data-in-save' + (s.busy ? ' disabled' : '') + '>' + (s.busy ? 'Saving…' : s.editing ? 'Save' : 'Add and work it out') + '</button></div></div></div>';
  const nb = o.querySelector('.split-body'); if (nb) nb.scrollTop = top;
}
async function inSave() {
  const s = inSheet; if (!s || s.busy) return;
  const f = s.f;
  if (!f.accountId) { s.err = 'Choose the account.'; inRender(); return; }
  if (s.own && !(Number(f.ratePercent) > 0)) { s.err = 'Enter the interest rate per year.'; inRender(); return; }
  s.busy = true; s.err = ''; inRender();
  const body = { accountId: f.accountId, creditFrequency: f.creditFrequency, creditAnchor: f.creditFrequency === 'daily' ? undefined : f.creditAnchor, recordMode: f.creditFrequency === 'daily' ? f.recordMode : undefined,
    balanceMaxAgeDays: f.balanceMaxAgeDays === '' ? undefined : Number(f.balanceMaxAgeDays), paused: f.paused };
  if (s.own) { body.annualRatePercent = Number(f.ratePercent); if (s.editing && s.origRate != null && Number(f.ratePercent) !== s.origRate) body.effectiveFrom = f.effectiveFrom; }
  try {
    await api('/api/interest/accounts', { method: 'POST', body: JSON.stringify(body) });
    inClose();
    try { await loadDashboard(); } catch { }
    if (typeof loadInterestSources === 'function') await loadInterestSources();
  } catch (e) { s.busy = false; s.err = String((e && e.message) || e); inRender(); }
}
document.addEventListener('click', async e => {
  const add = e.target.closest('[data-in-add]'); if (add) { inOpen(add.dataset.inAccount || ''); return; }
  const ed = e.target.closest('[data-in-edit]'); if (ed) { inOpen(ed.dataset.inEdit); return; }
  const pz = e.target.closest('[data-in-pause]');
  if (pz && inData) {
    const src = inData.sources.find(x => x.account_id === pz.dataset.inPause); if (!src) return;
    pz.disabled = true;
    try {
      await api('/api/interest/accounts', { method: 'POST', body: JSON.stringify({ accountId: src.account_id, creditFrequency: src.credit_frequency && IN_FREQ_WORD[src.credit_frequency] && src.credit_frequency !== 'on_maturity' ? src.credit_frequency : 'monthly', creditAnchor: src.credit_anchor || undefined, paused: !src.paused }) });
      if (typeof loadInterestSources === 'function') await loadInterestSources();
    } catch (err) { pz.disabled = false; alert(String(err.message || err)); }
    return;
  }
  if (!inSheet) return;
  const o = $('interestOverlay'); if (!o || !o.contains(e.target)) return;
  if (e.target.closest('[data-in-cancel]')) { inClose(); return; }
  const fq = e.target.closest('[data-in-freq]'); if (fq) { inSheet.f.creditFrequency = fq.dataset.inFreq; inRender(); return; }
  const rc = e.target.closest('[data-in-rec]'); if (rc) { inSheet.f.recordMode = rc.dataset.inRec; inRender(); return; }
  if (e.target.closest('[data-in-save]')) { inSave(); return; }
});
document.addEventListener('input', e => {
  if (!inSheet || !e.target.matches || !e.target.matches('#interestOverlay [data-in]')) return;
  inSheet.f[e.target.dataset.in] = e.target.value;
  if (e.target.dataset.in === 'ratePercent' && inSheet.editing && inSheet.own && (Number(e.target.value) !== inSheet.origRate) !== !!document.querySelector('#interestOverlay [data-in="effectiveFrom"]')) { const pos = e.target.selectionStart; inRender(); const i = document.querySelector('#interestOverlay [data-in="ratePercent"]'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch { } } return; }
  const ex = document.querySelector('#interestOverlay [data-in-example]'); if (ex) ex.textContent = inExample();
});
document.addEventListener('change', e => {
  if (!inSheet || !e.target.matches) return;
  if (e.target.matches('#interestOverlay select[data-in]')) { inSheet.f[e.target.dataset.in] = e.target.value; return; }
  if (e.target.matches('#interestOverlay [data-in-paused]')) inSheet.f.paused = e.target.checked;
});
document.addEventListener('keydown', e => { if (inSheet && e.key === 'Escape') { e.preventDefault(); inClose(); } });

// The Add button at the top of the Interest page (the list of accounts is further down the page).
function inToolbarHtml() {
  return '<div class="in-toolbar"><div><b>Interest on your accounts</b><small>Add an account with its rate per year and how the bank pays it.</small></div>'
    + '<div class="in-toolbar-btns"><button type="button" class="primary in-add" data-in-add>+ Add account</button><button type="button" class="ghost" data-in-jump>Your accounts ↓</button></div></div>';
}
document.addEventListener('click', e => { if (!e.target.closest('[data-in-jump]')) return; const p = document.querySelector('.in-page'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

// ---- Interest by day: chart, totals and the daily list for EVERY interest account (2026-11-14) ------------------------------
// Replaces the fixed "Slice Savings / Atom / FD" view: each account the app works interest out for is its own series (fixed deposits
// stay together as one). Slice and Atom keep their statement figures. Uses app.js's interestLatestLedger(), interestMonthTotal(),
// interestStatementFor(), interestSeriesKey(), interestFdSplit(), chartWidget(), CHARTS, accounts, money().
const IN_COLORS = ['#66dcb8', '#85aaff', '#c792ea', '#ff9eb5', '#7fd3f7', '#ffd27f', '#a5e887', '#f7a072'];
function inSourceName(key) {
  if (key === 'slice-savings') return 'Slice Savings';
  if (key === 'atom-savings') return 'Atom';
  if (key === 'fd') return 'Fixed deposits';
  if (key.startsWith('my-')) { const a = (typeof accounts !== 'undefined' && Array.isArray(accounts) ? accounts : []).find(x => x.id === key.slice(3)); if (a) return a.account_name || a.bank_name; }
  const s = inData && inData.sources ? inData.sources.find(x => x.product_key === key) : null;
  return s ? s.account_name : interestProductLabel(key);
}
// key per ledger product: every FD product -> 'fd'; everything else is its own source.
const inKeyOf = p => (interestSeriesKey(p) === 'fd' ? 'fd' : String(p || ''));
function inDaily(maxDays = 31) {
  const byDate = {}, keys = new Set();
  const row = date => (byDate[date] ||= { date, v: {}, fdParts: {} });
  for (const x of interestLatestLedger()) {
    const date = String(x.accrual_date || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const k = inKeyOf(x.product_key), r = row(date), amt = Number(x.interest_amount || 0); keys.add(k);
    if (k === 'fd') { r.fdParts[x.product_key] = amt; r.v.fd = Math.round(((r.v.fd || 0) + amt) * 1e8) / 1e8; }
    else r.v[k] = Math.round(((r.v[k] || 0) + amt) * 1e8) / 1e8;
  }
  // Bank statements give Slice / Atom their exact daily figures.
  for (const key of ['slice-savings', 'atom-savings']) {
    const st = interestStatementFor(key); if (!st) continue;
    let days = st.daily_breakdown; if (typeof days === 'string') { try { days = JSON.parse(days); } catch { days = []; } }
    for (const day of Array.isArray(days) ? days : []) {
      const date = String(day.accrual_date || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (key === 'slice-savings' && Number.isFinite(Number(day.amount))) { row(date).v[key] = Number(day.amount); keys.add(key); }
      else if (key === 'atom-savings' && Array.isArray(day.components) && day.complete === true) { row(date).v[key] = Number(day.components.reduce((n, c) => n + Number(c.amount || 0), 0).toFixed(2)); keys.add(key); }
    }
  }
  const order = k => (k === 'slice-savings' ? 0 : k === 'atom-savings' ? 1 : k === 'fd' ? 9 : 2);
  const list = [...keys].sort((a, b) => order(a) - order(b) || inSourceName(a).localeCompare(inSourceName(b)));
  return { keys: list, days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-maxDays) };
}
function inMonthTotal(key) {
  if (key !== 'fd') return interestMonthTotal(key);
  const fdKeys = [...new Set(interestLatestLedger().map(x => x.product_key).filter(p => inKeyOf(p) === 'fd'))];
  const parts = fdKeys.map(interestMonthTotal);
  return { month: parts.map(p => p.month).find(Boolean) || '', statementThrough: null, total: Math.round(parts.reduce((n, m) => n + m.total, 0) * 100) / 100, split: Object.fromEntries(fdKeys.map((k, i) => [k, parts[i].total])) };
}
function inSummaryHtml() {
  const { keys, days } = inDaily(), color = k => IN_COLORS[keys.indexOf(k) % IN_COLORS.length] || '#9fb3cf';
  const known = days.filter(d => Object.keys(d.v).length), dayTotal = d => Object.values(d.v).reduce((n, v) => n + v, 0);
  const months = Object.fromEntries(keys.map(k => [k, inMonthTotal(k)]));
  const total = Math.round(keys.reduce((n, k) => n + months[k].total, 0) * 100) / 100;
  const month = keys.map(k => months[k].month).find(Boolean) || (known.length ? known[known.length - 1].date.slice(0, 7) : '');
  const monthName = month ? new Date(month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short' }) : '';
  const basis = keys.map(k => months[k].statementThrough).find(Boolean);
  const latest = known[known.length - 1], recent = known.slice(-7), avg = recent.length ? recent.reduce((n, d) => n + dayTotal(d), 0) / recent.length : 0;
  const dim = month ? new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate() : 30, covered = latest && latest.date.startsWith(month) ? +latest.date.slice(8, 10) : 0;
  const projected = month ? Math.round((total + avg * Math.max(0, dim - covered)) * 100) / 100 : 0;
  const day = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const rateOf = k => { const rows = interestLatestLedger().filter(x => inKeyOf(x.product_key) === k); const per = [...new Set(rows.map(x => x.product_key))].map(p => rows.filter(x => x.product_key === p).sort((a, b) => String(b.accrual_date).localeCompare(String(a.accrual_date)))[0]).map(x => Number(x.annual_rate) * 100).filter(Number.isFinite); if (!per.length) return ''; const lo = Math.min(...per), hi = Math.max(...per), f = v => v.toFixed(2).replace(/\.?0+$/, ''); return lo === hi ? f(lo) + '% p.a.' : f(lo) + '–' + f(hi) + '% p.a.'; };
  const sources = keys.map(k => ({ key: k, name: inSourceName(k), amount: months[k].total, color: color(k), rate: rateOf(k), sub: k === 'fd' && Object.keys(months[k].split || {}).length > 1 ? interestFdSplit(months[k].split) : '' }));
  const hidden = (CHARTS['interest-day'] && CHARTS['interest-day'].hidden) || new Set();
  const head = '<div class="int-head"><div><span class="interest-kicker">INTEREST</span><h3>Interest by day</h3><p>' + esc(monthName ? monthName + ' to date' : 'Month to date') + ' · ' + sources.length + ' source' + (sources.length === 1 ? '' : 's') + '</p></div><div class="int-total"><strong>' + money(total) + '</strong><small>' + (basis ? 'statement to ' + esc(day(basis)) + ' + daily after' : 'earned this month') + '</small></div></div>';
  const kpis = '<div class="int-kpis"><div class="int-kpi"><small>Latest day</small><b>' + (latest ? money(dayTotal(latest)) : '—') + '</b><span>' + (latest ? esc(day(latest.date)) : 'no data yet') + '</span></div>'
    + '<div class="int-kpi"><small>Daily average</small><b>' + (recent.length ? money(avg) : '—') + '</b><span>last ' + recent.length + ' day' + (recent.length === 1 ? '' : 's') + '</span></div>'
    + '<div class="int-kpi"><small>' + esc(monthName ? monthName + ' projected' : 'Projected') + '</small><b>' + (recent.length ? money(projected) : '—') + '</b><span>estimate at this pace</span></div></div>';
  const rows = '<div class="int-sources" role="group" aria-label="Interest sources — tap to show or hide on the chart">' + sources.map(s => { const pct = total > 0 ? Math.max(0, s.amount / total * 100) : 0, off = hidden.has(s.key); return '<button type="button" class="int-src' + (off ? ' off' : '') + '" data-chart-toggle="' + esc(s.key) + '" data-chart-target="interest-day" aria-pressed="' + (!off) + '"><i style="background:' + s.color + '"></i><span class="int-src-name"><b>' + esc(s.name) + '</b><small>' + esc([s.rate].filter(Boolean).join(' · ') || 'rate not recorded') + (s.sub ? ' · ' + s.sub : '') + '</small></span><span class="int-src-amt"><b>' + money(s.amount) + '</b><small>' + (pct >= 0.1 ? pct.toFixed(pct >= 10 ? 0 : 1) + '%' : '<0.1%') + '</small></span><span class="int-src-bar"><em style="width:' + pct.toFixed(1) + '%;background:' + s.color + '"></em></span></button>'; }).join('') + '</div>';
  const def = { title: 'Daily interest earned', ranged: false, legend: false, format: v => money(v),
    series: sources.map(s => ({ key: s.key, name: s.name, legend: s.name + ' · ' + money(s.amount), color: s.color })),
    points: days.map(d => ({ x: d.date, values: Object.fromEntries(keys.map(k => [k, d.v[k] != null ? d.v[k] : null])), extra: ['Day total ' + money(dayTotal(d)), Object.keys(d.fdParts).length > 1 ? interestFdSplit(d.fdParts) : ''].filter(Boolean).join(' · ') })) };
  const chart = known.length ? chartWidget('interest-day', def) : '<div class="interest-empty"><b>No daily interest data yet</b><p>Daily points appear when statements or the nightly job save dated interest.</p></div>';
  const how = '<details class="int-how"><summary>How this is calculated</summary><p>Every account that earns interest is listed here. Month to date = the bank statement up to its end date (Slice, Atom), plus the app\'s daily interest for later days: your latest balance × the rate per year ÷ 365. Accounts paid monthly, every 2 months or later earn every day here and are paid at the end of each period. Days without data are gaps, never zero. The projection adds the last 7 days\' average for each remaining day of the month.</p></details>';
  const link = activeView === 'interest' ? '' : '<button type="button" class="int-link" data-view="interest">Interest details →</button>';
  return '<section class="interest-source interest-by-day int-card">' + head + kpis + rows + chart + '<div class="int-foot">' + how + link + '</div></section>';
}
function inDailyListHtml() {
  const html = inDailyListInner();
  return '<div id="inDaily">' + html + '</div>';
}
function inDailyListInner() {
  const { keys, days } = inDaily(180), run = {};
  // Running totals restart each month ("to date" = month to date).
  const all = days.map(d => { if (run._m !== d.date.slice(0, 7)) { for (const k of Object.keys(run)) delete run[k]; run._m = d.date.slice(0, 7); } for (const k of keys) if (d.v[k] != null) run[k] = (run[k] || 0) + d.v[k]; return { ...d, mtd: { ...run } }; }).reverse();
  const pg = inPager('daily', all.length), rows = all.slice(pg.from, pg.to);
  const color = k => IN_COLORS[keys.indexOf(k) % IN_COLORS.length] || '#9fb3cf';
  return '<section class="interest-daily"><div class="interest-section-head"><div><span class="interest-kicker">DAILY BREAKDOWN</span><h3>Interest earned each day</h3><p>Latest dates first · every interest account · running totals</p></div><span class="interest-count">' + all.length + ' days</span></div>'
    + (rows.length ? '<div class="interest-day-list">' + rows.map(x => '<article class="interest-day"><div class="interest-day-date"><b>' + new Date(x.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + '</b><span>' + new Date(x.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }) + '</span></div><div class="interest-day-products">'
      + keys.map(k => '<div><span class="interest-dot" style="background:' + color(k) + '"></span><small>' + esc(inSourceName(k)) + '</small><b>' + (x.v[k] != null ? money(x.v[k]) : 'Not recorded') + '</b><em>month to date ' + money(x.mtd[k] || 0) + '</em>' + (k === 'fd' && Object.keys(x.fdParts).length > 1 ? '<small class="interest-fd-split">' + interestFdSplit(x.fdParts) + '</small>' : '') + '</div>').join('') + '</div></article>').join('') + '</div>'
      : '<div class="interest-empty"><b>No daily entries yet</b><p>Daily interest appears here when you add an account with its rate, or when a statement is saved.</p></div>')
    + pg.html + '<p class="interest-note">Missing values are not treated as zero. Monthly statement totals above are not added again to daily entries.</p></section>';
}

// ---- 10 rows per page, with page buttons, for the daily list and the interest received list -------------------------------
const IN_PAGE_SIZE = 10, IN_PAGE = { daily: 0, hist: 0 };
function inPager(name, total) {
  const pages = Math.max(1, Math.ceil(total / IN_PAGE_SIZE));
  const p = Math.min(Math.max(IN_PAGE[name] || 0, 0), pages - 1); IN_PAGE[name] = p;
  const from = p * IN_PAGE_SIZE, to = Math.min(total, from + IN_PAGE_SIZE);
  const html = total > IN_PAGE_SIZE ? '<nav class="in-pager" aria-label="Pages"><button type="button" class="ghost" data-in-page="' + name + '" data-in-to="' + (p - 1) + '"' + (p === 0 ? ' disabled' : '') + '>‹ Newer</button>'
    + '<span>' + (from + 1) + '–' + to + ' of ' + total + ' · page ' + (p + 1) + ' of ' + pages + '</span>'
    + '<button type="button" class="ghost" data-in-page="' + name + '" data-in-to="' + (p + 1) + '"' + (p >= pages - 1 ? ' disabled' : '') + '>Older ›</button></nav>' : '';
  return { from, to, html };
}
function inHistInner() {
  const all = (inData && inData.history) || [], pg = inPager('hist', all.length);
  return '<details class="rw-cats in-hist" open><summary>Interest received (' + all.length + ')</summary><div class="in-hist-list">'
    + all.slice(pg.from, pg.to).map(h => '<div class="in-hist-row"><span><b>' + esc(h.account) + '</b><small>' + esc(h.description || 'Interest') + '</small></span><span class="in-hist-amt"><b>+' + esc(inRs(h.amount)) + '</b><small>' + esc(inDay(h.occurred_on)) + '</small></span></div>').join('')
    + '</div>' + pg.html + '</details>';
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-in-page]'); if (!b) return;
  IN_PAGE[b.dataset.inPage] = Number(b.dataset.inTo);
  const box = $(b.dataset.inPage === 'daily' ? 'inDaily' : 'inHist');
  if (box) { box.innerHTML = b.dataset.inPage === 'daily' ? inDailyListInner() : inHistInner(); box.scrollIntoView({ block: 'nearest' }); }
});
