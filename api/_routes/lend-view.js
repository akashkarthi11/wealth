import { json, body as readBody, rateLimit, clientIp, httpError, sendError } from '../_lib.js';
import { publicLendView, createLendRequest, addLendComment, validToken } from '../_lendshare.js';

// Public (no sign-in): /l/<secret> → this route (vercel.json rewrite).
// GET  the person's own lending summary as a small page.   POST {amount, paidOn, method, note} — "I've paid" request.
// Only that person's entries are shown; nothing about accounts, other people or the owner's money.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inr = v => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = d => { const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(x.getTime()) ? x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(d || ''); };
const METHOD = { upi: 'UPI', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{color-scheme:dark;--bg:#0b1220;--card:#121d30;--line:#26364e;--text:#eef4ff;--muted:#8fa2bd;--green:#6ce0b0;--amber:#ffcf8a;--blue:#83aaff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 20% 0%,#1b3150 0,transparent 50%),var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,sans-serif}
main{max-width:520px;margin:0 auto;padding:22px 16px 48px}.brand{font-size:11px;letter-spacing:1.6px;color:var(--muted);text-transform:uppercase}
h1{font-size:22px;margin:6px 0 2px}.card{background:linear-gradient(150deg,#16253c,#101a2b);border:1px solid var(--line);border-radius:18px;padding:18px;margin-top:14px}
.big{font-size:34px;font-weight:800;margin:4px 0}.big.ok{color:var(--green)}.muted{color:var(--muted);font-size:13px}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #1f2e44}.row:last-child{border-bottom:0}.row span{display:grid;gap:2px;min-width:0}
.row small{color:var(--muted);font-size:12px}.out{color:var(--amber)}.in{color:var(--green)}.off{opacity:.5;text-decoration:line-through}
label{display:grid;gap:6px;font-size:12px;color:#b6c6dc;margin:10px 0}input,select{width:100%;background:#0b1524;border:1px solid #30425d;border-radius:10px;padding:12px;color:#fff;font:inherit}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{width:100%;margin-top:12px;border:0;border-radius:12px;padding:14px;font:inherit;font-weight:750;color:#081522;background:linear-gradient(110deg,#78a8ff,#65ddb2);cursor:pointer}
button[disabled]{opacity:.5}.msg{min-height:18px;font-size:13px;margin-top:8px}.msg.err{color:#ffb2a9}.msg.ok{color:var(--green)}
.row .pill{display:inline-block;align-self:center;height:auto}.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:12px;border:1px solid var(--line);color:var(--muted)}.pill.wait{color:var(--amber);border-color:#6b5230}.pill.done{color:var(--green);border-color:#2d5a4c}
footer{margin-top:22px;font-size:11px;color:#60728d;text-align:center}
.item{border-bottom:1px solid #1f2e44}.item:last-child{border-bottom:0}.item .row{border-bottom:0}.cm{margin:0 0 8px 10px;padding:8px 10px;border-radius:10px;background:#0f1b2d;border:1px solid #22344e;font-size:13px}.cm p{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.cm small{color:var(--muted);font-size:11px}.cm-owner{border-color:#2f5a4a;background:#10261f}.cm-owner b{color:var(--green)}.cm-me b{color:var(--blue)}
.cform{display:flex;gap:8px;margin:2px 0 12px 10px}.cform input{padding:9px 10px;font-size:13px}.cform button{width:auto;margin-top:0;padding:9px 14px}
</style></head><body><main>${inner}</main></body></html>`;
}

export function viewHtml(v) {
  const settled = !(v.owed > 0);
  const items = v.items.map(i => {
    const ref = i.entryId ? `data-entry="${esc(i.entryId)}"` : i.shareId ? `data-share="${esc(i.shareId)}"` : '';
    const cms = (i.comments || []).map(c => `<div class="cm ${c.author === 'owner' ? 'cm-owner' : 'cm-me'}"><b>${c.author === 'owner' ? 'Karthi' : 'You'}</b> <small>${esc(day(c.at))}</small><p>${esc(c.body)}</p></div>`).join('');
    const form = ref ? `<form class="cform" ${ref}><input name="body" maxlength="300" placeholder="Add a comment on this row" aria-label="Comment on this row" required><button type="submit">Send</button></form>` : '';
    return `<div class="item"><div class="row"><span><b>${esc(i.label)}</b><small>${esc(day(i.on))}${i.detail ? ' · ' + esc(i.detail) : ''}${i.note ? ' · “' + esc(i.note) + '”' : ''}${i.writtenOff ? ' · written off' : ''}${i.paid ? ' · paid' : ''}</small></span><b class="${i.direction === 'out' ? 'out' : 'in'}${i.writtenOff ? ' off' : ''}">${i.direction === 'out' ? '' : '−'}${esc(inr(i.amount))}</b></div>${cms}${form}</div>`;
  }).join('');
  const reqs = v.requests.map(r => `<div class="row"><span><b>You said you paid ${esc(inr(r.amount))}</b><small>${esc(day(r.paidOn))} · ${esc(METHOD[r.method] || r.method)}</small></span><span class="pill ${r.status === 'pending' ? 'wait' : r.status === 'accepted' ? 'done' : ''}">${r.status === 'pending' ? 'Waiting' : r.status === 'accepted' ? 'Confirmed' : 'Not confirmed'}</span></div>`).join('');
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const form = settled ? '' : `<section class="card"><h2 style="margin:0;font-size:17px">I've paid</h2><p class="muted" style="margin:4px 0 0">Tell Karthi you paid. It is marked as paid once confirmed.</p>
<form id="paid"><label>Amount (₹)<input name="amount" type="number" min="1" step="0.01" inputmode="decimal" required value="${esc(String(v.owed))}"></label>
<div class="two"><label>Date<input name="paidOn" type="date" max="${today}" value="${today}" required></label><label>How<select name="method"><option value="upi">UPI</option><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option></select></label></div>
<label>Note (optional)<input name="note" maxlength="200" placeholder="e.g. UPI ref 4417…"></label><button type="submit">Send</button><p class="msg" id="msg" role="status"></p></form></section>
<script>
document.getElementById('paid').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button'),m=document.getElementById('msg');b.disabled=true;m.className='msg';m.textContent='Sending…';
 try{const d=Object.fromEntries(new FormData(f));const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||'Could not send. Please try again.');m.className='msg ok';m.textContent='Sent. Karthi will confirm it.';setTimeout(()=>location.reload(),1200)}
 catch(err){m.className='msg err';m.textContent=err.message;b.disabled=false}});
</script>`;
  return page(`${v.name} · what you owe`, `<div class="brand">Karthi's ledger · shared with you</div><h1>Hi ${esc(v.name)}</h1>
<section class="card"><div class="muted">${settled ? 'All settled' : 'You owe Karthi'}</div><div class="big ${settled ? 'ok' : ''}">${esc(inr(settled ? 0 : v.owed))}</div>
<div class="muted">Given ${esc(inr(v.lent))} · paid back ${esc(inr(v.repaid))} · as of ${esc(day(v.asOf))}</div></section>
${reqs ? `<section class="card"><h2 style="margin:0 0 4px;font-size:15px">Your payments</h2>${reqs}</section>` : ''}
${form}
<section class="card"><h2 style="margin:0 0 4px;font-size:15px">Details</h2>${items || '<p class="muted">Nothing yet.</p>'}</section>
<footer>This page shows only your entries. Keep the link private.</footer>
<script>
document.querySelectorAll('.cform').forEach(f=>f.addEventListener('submit',async e=>{e.preventDefault();const b=f.querySelector('button'),i=f.querySelector('input');b.disabled=true;
 try{const d={kind:'comment',body:i.value};if(f.dataset.entry)d.entryId=f.dataset.entry;else d.shareId=f.dataset.share;const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||'Could not send. Please try again.');location.reload()}
 catch(err){alert(err.message);b.disabled=false}}));
</script>`);
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'https://local');
  const token = url.searchParams.get('t') || '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    if (!validToken(token)) throw httpError(404, 'This link is not valid.');
    if (req.method === 'GET') {
      const v = await publicLendView(token);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!v) { res.statusCode = 404; return res.end(page('Link not valid', '<div class="brand">Karthi\'s ledger</div><h1>This link is not valid any more</h1><p class="muted">Ask for a new link.</p>')); }
      res.statusCode = 200;
      return res.end(viewHtml(v));
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const b = await readBody(req);
    const isComment = b?.kind === 'comment';
    const lim = await rateLimit((isComment ? 'lend-comment:' : 'lend-link:') + clientIp(req), isComment ? 30 : 10, 3600).catch(() => ({ allowed: true }));
    if (lim && lim.allowed === false) return json(res, 429, { error: 'Too many tries. Please wait a while.' });
    const r = isComment ? await addLendComment(token, b) : await createLendRequest(token, b);
    return json(res, 201, r);
  } catch (e) { return sendError(res, e, 'wealth-lend-view'); }
}
