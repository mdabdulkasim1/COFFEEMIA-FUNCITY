// Counter POS (card counter E): issue, top-up, balance, return, reports, setup.
import { $, $$, esc, api, setCurrency, money, dt, dtFull, mmss, toast, beep, modal, askPin } from './common.js';
import { attachScanner } from './scan.js';

const state = { user: null, login_required: false, users: [], settings: {}, machines: [], packages: [], shift: null, uid: null, card: null, history: [], cart: null, pin: null, range: 'today' };

// ---------- boot ----------
async function boot() {
  const b = await api('GET', '/api/bootstrap');
  Object.assign(state, { user: b.user, login_required: b.login_required, settings: b.settings, machines: b.machines, packages: b.packages, shift: b.shift });
  $('#userName').textContent = b.user ? `${b.user.username} (${b.user.role})` : 'no login set';
  setCurrency(state.settings.currency);
  $('#brandName').textContent = state.settings.brand;
  document.title = `${state.settings.brand} · Card Counter POS`;
  $('#setupBanner').classList.toggle('hidden', state.settings.setup_done === '1');
  renderShift();
}
function tick() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
setInterval(tick, 1000); tick();

// ---------- tabs ----------
function showTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'live') startLive(); else stopLive();
  if (name === 'reports') runReport();
  if (name === 'cards') searchCards();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$$('[data-goto]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.goto)));

// ---------- shift ----------
function renderShift() {
  const s = state.shift;
  $('#shiftPill .st').classList.toggle('open', Boolean(s));
  $('#shiftText').textContent = s ? `${s.staff} · since ${new Date(s.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No shift open';
  $('#shiftBtn').textContent = s ? 'Close shift' : 'Open shift';
  $('#shiftBtn').className = `btn sm ${s ? 'danger' : 'yellow'}`;
}
$('#shiftBtn').addEventListener('click', () => state.shift ? closeShiftModal() : openShiftModal());

function openShiftModal() {
  modal(`<h3>Open shift</h3>
    <div class="field"><label>Staff name</label><input id="shStaff" type="text" autofocus></div>
    <div class="field"><label>Opening cash in drawer</label><input id="shCash" type="number" step="0.01" value="0"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="shOk">Open shift</button></div>`,
    { onOpen: (el, close) => {
      if (state.user) $('#shStaff', el).value = state.user.username;
      $('#shStaff', el).focus();
      $('#shOk', el).onclick = async () => {
        try { state.shift = await api('POST', '/api/shifts/open', { staff: $('#shStaff', el).value, opening_cash: $('#shCash', el).value }); renderShift(); close(); toast('Shift opened', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      };
    } });
}
function closeShiftModal() {
  modal(`<h3>Close shift · ${esc(state.shift.staff)}</h3>
    <div id="shSummary" class="muted small">Loading…</div>
    <div class="field" style="margin-top:10px"><label>Cash counted in drawer</label><input id="shCash" type="number" step="0.01"></div>
    <div class="field"><label>Note</label><input id="shNote" type="text"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="shOk">Close shift</button></div>`,
    { onOpen: async (el, close) => {
      const shifts = await api('GET', '/api/shifts');
      const cur = shifts.find(s => s.id === state.shift.id);
      const t = cur?.totals ?? {};
      const expected = (state.shift.opening_cash + (t.by_method?.cash ?? 0));
      $('#shSummary', el).innerHTML = `<div class="kv">
        <b>Opening cash</b><span>${money(state.shift.opening_cash)}</span>
        <b>Cash taken</b><span>${money(t.by_method?.cash)}</span><b>Card</b><span>${money(t.by_method?.card)}</span><b>Online</b><span>${money(t.by_method?.online)}</span>
        <b>Points sold</b><span>${t.credits_sold ?? 0}</span><b>Points used</b><span>${t.credits_used ?? 0}</span>
        <b>Cards issued / returned</b><span>${t.cards_issued ?? 0} / ${t.cards_returned ?? 0}</span>
        <b>Expected cash in drawer</b><span><b>${money(expected)}</b></span></div>`;
      $('#shCash', el).value = expected.toFixed(2); $('#shCash', el).focus();
      $('#shOk', el).onclick = async () => {
        try {
          const r = await api('POST', '/api/shifts/close', { closing_cash: $('#shCash', el).value, note: $('#shNote', el).value });
          state.shift = null; renderShift(); close();
          const diff = (r.closing_cash - r.expected_cash);
          toast(`Shift closed. Cash difference ${diff >= 0 ? '+' : ''}${money(diff)}`, Math.abs(diff) < 0.01 ? 'ok' : 'info', 6000);
        } catch (e) { toast(e.message, 'error'); }
      };
    } });
}

// ---------- card lookup ----------
attachScanner(uid => { $('#manualUid').value = ''; lookup(uid); });
$('#manualGo').addEventListener('click', () => lookup($('#manualUid').value));
$('#manualUid').addEventListener('keydown', e => { if (e.key === 'Enter') lookup(e.target.value); });
$('#tapzone').addEventListener('click', e => { if (!e.target.closest('button')) $('#manualUid').focus(); });
$('#newCardBtn').addEventListener('click', async () => {
  try { const { codes } = await api('POST', '/api/cards/next', { count: 1 }); await lookup(codes[0]); toast(`New card number ${codes[0]} reserved`, 'ok'); }
  catch (e) { toast(e.message, 'error'); }
});

async function lookup(uid) {
  uid = String(uid || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!uid) return;
  $('#tapzone').classList.remove('flash'); void $('#tapzone').offsetWidth; $('#tapzone').classList.add('flash');
  try {
    const r = await api('GET', `/api/cards/${encodeURIComponent(uid)}`);
    beep('ok');
    state.uid = uid; state.card = r.found ? r.card : null; state.history = r.transactions ?? []; state.active = r.active_plays ?? [];
    state.cart = null; renderCart();
    renderCardPanel();
    showTab('counter');
  } catch (e) { beep('error'); toast(e.message, 'error'); }
}

function renderCardPanel() {
  const p = $('#cardPanel'); p.classList.remove('hidden');
  const c = state.card;
  if (!c || c.status === 'returned') {
    const dep = Number(state.settings.card_deposit);
    p.innerHTML = `<div class="row between"><h2>${c ? 'Returned card · issue again' : 'New card'} <span class="badge new">${c ? 'returned' : 'not issued'}</span></h2><span class="mono muted">${esc(state.uid)}</span></div>
      <div class="fields" style="margin-top:8px">
        <div class="field"><label>Card no (printed)</label><input id="fCardNo" type="text" value="${esc(c?.card_no ?? state.uid)}" placeholder="printed on the card"></div>
        <div class="field"><label>Child / parent name</label><input id="fName" type="text"></div>
        <div class="field"><label>Phone</label><input id="fPhone" type="tel"></div>
        <div class="field"><label>Deposit</label><input id="fDeposit" type="number" step="0.01" value="${dep}"></div>
      </div>
      <h3 style="margin-top:8px">Choose a package</h3>
      <div class="pkgs" id="pkgPick">${pkgButtons()}</div>
      <div class="row" style="margin-top:10px"><label style="margin:0">Or custom points</label><input id="fCredits" type="number" min="0" step="1" style="width:120px" placeholder="0"><span class="muted small">at ${money(state.settings.credit_price)} per point</span></div>`;
    wirePurchasePick(p, 'issue');
    return;
  }
  const activeHtml = state.active.length ? `<div class="banner small" style="margin-top:8px">⏱ Playing now: ${state.active.map(a => `${esc(a.machine_name)} until ${new Date(a.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`).join(' · ')}</div>` : '';
  p.innerHTML = `<div class="row between"><h2>Card ${esc(c.card_no || '')} <span class="badge ${c.status}">${c.status}</span></h2><span class="mono muted">${esc(c.uid)}</span></div>
    <div class="grid cols-2" style="grid-template-columns:1fr 1fr">
      <div class="balance"><div><div class="lbl">BALANCE</div><div class="val">${c.balance} <span style="font-size:1rem">points</span></div></div><div class="small" style="text-align:right;opacity:.8">≈ ${money(c.balance * state.settings.credit_price)}<br>deposit ${money(c.deposit)}</div></div>
      <div class="kv"><b>Holder</b><span>${esc(c.holder_name || '—')}</span><b>Phone</b><span>${esc(c.phone || '—')}</span><b>Issued</b><span>${dt(c.issued_at)}</span><b>Last used</b><span>${dt(c.last_used_at)}</span>${c.note ? `<b>Note</b><span>${esc(c.note)}</span>` : ''}</div>
    </div>
    ${activeHtml}
    ${c.status === 'active' ? `<h3 style="margin-top:12px">Top up</h3><div class="pkgs" id="pkgPick">${pkgButtons()}</div>
    <div class="row" style="margin-top:10px"><label style="margin:0">Or custom points</label><input id="fCredits" type="number" min="0" step="1" style="width:120px" placeholder="0"><span class="muted small">at ${money(state.settings.credit_price)} per point</span></div>` : ''}
    <div class="row" style="margin-top:14px">
      ${c.status === 'active' ? `<button class="btn sm" id="actAdjust">± Adjust points</button><button class="btn sm" id="actBlock">Block card</button>` : `<button class="btn sm green" id="actUnblock">Unblock card</button>`}
      <button class="btn sm danger" id="actReturn">Return card &amp; refund</button>
    </div>
    <h3 style="margin-top:14px">Recent activity</h3>
    <div class="scroll" style="max-height:220px"><table><tbody>${state.history.map(t => `<tr class="${t.type}"><td class="muted small">${dt(t.ts)}</td><td>${esc(t.note || t.type)}</td><td class="num">${t.credits > 0 ? '+' : ''}${t.credits || ''}</td><td class="num">${t.amount || t.deposit ? money(t.amount + t.deposit) : ''}</td><td class="muted small">${t.method || ''}</td></tr>`).join('') || '<tr><td class="muted">No activity yet</td></tr>'}</tbody></table></div>`;
  if (c.status === 'active') wirePurchasePick(p, 'topup');
  $('#actAdjust')?.addEventListener('click', adjustModal);
  $('#actBlock')?.addEventListener('click', blockCard);
  $('#actUnblock')?.addEventListener('click', unblockCard);
  $('#actReturn')?.addEventListener('click', returnModal);
}

function pkgButtons() {
  return state.packages.filter(p => p.active).map(p => `<button class="pkg" data-pkg="${p.id}"><div class="n">${esc(p.name)}</div><div class="c">${p.credits}${p.bonus ? ` <span class="b">+${p.bonus} free</span>` : ''}</div><div class="p">${money(p.price)}</div><div class="muted small">${esc(p.note || '')}</div></button>`).join('');
}
function wirePurchasePick(root, kind) {
  $$('.pkg', root).forEach(b => b.addEventListener('click', () => {
    $$('.pkg', root).forEach(x => x.classList.toggle('sel', x === b));
    $('#fCredits', root).value = '';
    const p = state.packages.find(x => x.id === Number(b.dataset.pkg));
    setCart(kind, { package_id: p.id, label: `${p.name} · ${p.credits}${p.bonus ? ` + ${p.bonus} free` : ''} points`, credits: p.credits + p.bonus, amount: p.price });
  }));
  $('#fCredits', root).addEventListener('input', e => {
    $$('.pkg', root).forEach(x => x.classList.remove('sel'));
    const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
    if (n) setCart(kind, { credits: n, label: `${n} points`, amount: Math.round(n * state.settings.credit_price * 100) / 100 });
    else if (kind === 'issue') setCart('issue', null); else { state.cart = null; renderCart(); }
  });
  if (kind === 'issue') setCart('issue', null);
}

// ---------- cart / charge ----------
function setCart(kind, buy) {
  state.cart = { kind, buy, method: state.cart?.method ?? 'cash' };
  renderCart();
}
function renderCart() {
  const box = $('#cartLines');
  const c = state.cart;
  if (!c) { box.className = 'muted'; box.textContent = state.uid ? 'Pick a package or enter points.' : 'Scan a card to start.'; return; }
  const deposit = c.kind === 'issue' ? Number($('#fDeposit')?.value ?? state.settings.card_deposit) : 0;
  const total = (c.buy?.amount ?? 0) + deposit;
  box.className = '';
  box.innerHTML = `
    <div class="line"><span>${c.kind === 'issue' ? 'New card' : 'Top-up'} · <span class="mono">${esc(state.card?.card_no || state.uid)}</span></span><span></span></div>
    ${c.buy ? `<div class="line"><span>${esc(c.buy.label)}</span><span>${money(c.buy.amount)}</span></div>` : ''}
    ${c.kind === 'issue' ? `<div class="line"><span>Card deposit (refundable)</span><span>${money(deposit)}</span></div>` : ''}
    <div class="total"><span>Total due</span><span>${money(total)}</span></div>
    <div class="row between" style="margin-top:12px"><label style="margin:0">Paid by</label><div class="seg" id="paySeg">${['cash', 'card', 'online'].map(m => `<button data-m="${m}" class="${c.method === m ? 'active' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
    <button class="btn big primary block" id="chargeBtn" style="margin-top:12px" ${c.kind === 'topup' && !c.buy ? 'disabled' : ''}>Charge ${money(total)} &amp; print</button>
    ${!state.shift ? '<div class="muted small" style="margin-top:6px">⚠ No shift open. The sale will still be recorded, but cash won\'t be counted in a shift.</div>' : ''}`;
  $$('#paySeg button').forEach(b => b.addEventListener('click', () => { state.cart.method = b.dataset.m; renderCart(); }));
  $('#chargeBtn').addEventListener('click', charge);
  $('#fDeposit')?.addEventListener('input', renderCart, { once: true });
}

async function charge() {
  const c = state.cart; if (!c) return;
  const btn = $('#chargeBtn'); btn.disabled = true;
  try {
    let r, lines = [];
    if (c.kind === 'issue') {
      const body = { uid: state.uid, card_no: $('#fCardNo').value, holder_name: $('#fName').value, phone: $('#fPhone').value, deposit: $('#fDeposit').value, method: c.method,
        ...(c.buy?.package_id ? { package_id: c.buy.package_id } : { credits: c.buy?.credits ?? 0 }) };
      r = await api('POST', '/api/cards/issue', body);
      if (c.buy) lines.push([c.buy.label, r.transaction.amount]);
      lines.push(['Card deposit (refundable)', r.transaction.deposit]);
    } else {
      r = await api('POST', `/api/cards/${encodeURIComponent(state.uid)}/topup`, { method: c.method, ...(c.buy.package_id ? { package_id: c.buy.package_id } : { credits: c.buy.credits }) });
      lines.push([c.buy.label, r.transaction.amount]);
    }
    beep('start');
    printReceipt({ title: c.kind === 'issue' ? 'NEW PLAY CARD' : 'TOP-UP', card: r.card, lines, total: r.total_due, method: c.method, tx: r.transaction });
    $('#lastSale').innerHTML = `<div class="row between"><div><b>Last sale</b> · ${esc(r.card.card_no || r.card.uid)} · ${money(r.total_due)} ${c.method}<br><span class="muted small">Balance now ${r.card.balance} points</span></div><div class="row"><a class="btn sm yellow" href="/print-cards?codes=${encodeURIComponent(r.card.uid)}&no=${encodeURIComponent(r.card.card_no || '')}" target="_blank">🖨 Print card</a><button class="btn sm" id="reprint">Reprint receipt</button></div></div>`;
    $('#reprint').onclick = () => window.print();
    toast(`Done. Balance ${r.card.balance} points.`, 'ok');
    await lookup(state.uid);
  } catch (e) { beep('error'); toast(e.message, 'error'); btn.disabled = false; }
}

function printReceipt({ title, card, lines, total, method, tx, extra = [] }) {
  const s = state.settings;
  $('#receipt').innerHTML = `<div class="c"><img src="/img/logo.png" alt="" style="width:46mm;height:auto;display:inline-block"></div><h2>${esc(s.brand)}</h2>${s.receipt_header ? `<div class="c">${esc(s.receipt_header)}</div>` : ''}<hr>
    <div class="c"><b>${esc(title)}</b></div><div>${new Date(tx.ts).toLocaleString()}</div><div>Receipt #${tx.id}${tx.staff ? ` · ${esc(tx.staff)}` : ''}</div><hr>
    <div class="ln"><span>Card</span><span>${esc(card.card_no || '')} ${esc(card.uid)}</span></div>${card.holder_name ? `<div class="ln"><span>Name</span><span>${esc(card.holder_name)}</span></div>` : ''}<hr>
    ${lines.map(([l, v]) => `<div class="ln"><span>${esc(l)}</span><span>${money(v)}</span></div>`).join('')}
    ${extra.map(([l, v]) => `<div class="ln"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join('')}<hr>
    <div class="ln tot"><span>${total < 0 ? 'REFUNDED' : 'TOTAL'}</span><span>${money(Math.abs(total))}</span></div><div class="ln"><span>Paid by</span><span>${esc(method)}</span></div><hr>
    <div class="ln tot"><span>Balance</span><span>${card.balance} points</span></div><div class="ln"><span>Deposit held</span><span>${money(card.deposit)}</span></div><hr>
    <div class="c">${esc(s.receipt_footer)}</div><div class="c">Thank you · ${esc(s.brand)}</div>`;
  setTimeout(() => window.print(), 50);
}

// ---------- card actions ----------
async function withPin(fn) {
  const pin = state.pin || await askPin();
  if (!pin) return;
  try { await fn(pin); state.pin = pin; }
  catch (e) { if (e.status === 403) { state.pin = null; toast('Wrong PIN', 'error'); } else toast(e.message, 'error'); beep('error'); }
}
function adjustModal() {
  modal(`<h3>Adjust points</h3><p class="muted small">Use when a machine failed mid-ride or for goodwill. No money changes hands.</p>
    <div class="field"><label>Points (+ add / − remove)</label><input id="adjN" type="number" step="1" class="big"></div>
    <div class="field"><label>Reason</label><input id="adjNote" type="text" placeholder="e.g. horse ride stopped early"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="adjOk">Apply</button></div>`,
    { onOpen: (el, close) => { $('#adjN', el).focus(); $('#adjOk', el).onclick = () => withPin(async pin => {
      const r = await api('POST', `/api/cards/${encodeURIComponent(state.uid)}/adjust`, { credits: Number($('#adjN', el).value), note: $('#adjNote', el).value }, pin);
      close(); toast(`Balance now ${r.card.balance}`, 'ok'); lookup(state.uid);
    }); } });
}
async function blockCard() {
  const note = prompt('Why block this card? (lost / misuse)') ?? null; if (note === null) return;
  try { await api('POST', `/api/cards/${encodeURIComponent(state.uid)}/block`, { note }); toast('Card blocked', 'ok'); lookup(state.uid); } catch (e) { toast(e.message, 'error'); }
}
function unblockCard() { withPin(async pin => { await api('POST', `/api/cards/${encodeURIComponent(state.uid)}/unblock`, {}, pin); toast('Card unblocked', 'ok'); lookup(state.uid); }); }
function returnModal() {
  const c = state.card; const s = state.settings;
  const refundOn = s.refund_credits_on_return === '1';
  const creditMoney = c.balance * Number(s.credit_price);
  modal(`<h3>Return card &amp; refund</h3>
    <div class="kv"><b>Deposit back</b><span>${money(c.deposit)}</span><b>Unused points</b><span>${c.balance} ≈ ${money(creditMoney)}</span></div>
    <div class="check" style="margin:12px 0"><input type="checkbox" id="retRefund" ${refundOn ? 'checked' : ''}><label for="retRefund" style="margin:0">Refund unused points too</label></div>
    <div class="row between"><label style="margin:0">Refund by</label><div class="seg" id="retSeg"><button data-m="cash" class="active">Cash</button><button data-m="card">Card</button><button data-m="online">Online</button></div></div>
    <div class="total" style="margin-top:12px;display:flex;justify-content:space-between;font-size:1.3rem;font-weight:900"><span>Pay customer</span><span id="retTotal"></span></div>
    <div class="row end" style="margin-top:12px"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="retOk">Return card</button></div>`,
    { onOpen: (el, close) => {
      let method = 'cash';
      const upd = () => { $('#retTotal', el).textContent = money(c.deposit + ($('#retRefund', el).checked ? creditMoney : 0)); };
      upd(); $('#retRefund', el).addEventListener('change', upd);
      $$('#retSeg button', el).forEach(b => b.onclick = () => { method = b.dataset.m; $$('#retSeg button', el).forEach(x => x.classList.toggle('active', x === b)); });
      $('#retOk', el).onclick = () => withPin(async pin => {
        const r = await api('POST', `/api/cards/${encodeURIComponent(state.uid)}/return`, { refund_credits: $('#retRefund', el).checked, method }, pin);
        close(); beep('done'); toast(`Refund ${money(r.refund_total)} to customer`, 'ok', 6000);
        printReceipt({ title: 'CARD RETURNED', card: { ...r.card, balance: 0 }, lines: [['Deposit refund', -r.refund_deposit], ['Unused points refund', -r.refund_credits_money]],
          total: -r.refund_total, method, tx: r.transaction, extra: r.credits_forfeited ? [['Points forfeited', r.credits_forfeited]] : [] });
        lookup(state.uid);
      });
    } });
}

// ---------- cards tab ----------
async function searchCards() {
  const rows = await api('GET', `/api/cards?q=${encodeURIComponent($('#cardSearch').value)}`);
  $('#cardsTable tbody').innerHTML = rows.map(c => `<tr><td><b>${esc(c.card_no || '—')}</b></td><td class="mono small">${esc(c.uid)}</td><td>${esc(c.holder_name || '')}</td><td>${esc(c.phone || '')}</td><td class="num">${c.balance}</td><td class="num">${money(c.deposit)}</td><td><span class="badge ${c.status}">${c.status}</span></td><td class="small muted">${dt(c.last_used_at)}</td><td><button class="btn sm" data-open="${esc(c.uid)}">Open</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No cards found</td></tr>';
  $$('#cardsTable [data-open]').forEach(b => b.onclick = () => lookup(b.dataset.open));
}
$('#cardSearchBtn').addEventListener('click', searchCards);
$('#cardSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchCards(); });

// ---------- live board ----------
let liveTimer = null;
async function renderLive() {
  try {
    const { board, server_time } = await api('GET', '/api/live');
    const skew = Date.now() - new Date(server_time).getTime();
    $('#board').innerHTML = board.map(m => {
      const left = m.ends_at ? (new Date(m.ends_at).getTime() - (Date.now() - skew)) / 1000 : null;
      return `<div class="mach ${m.play_id && left > 0 ? 'busy' : ''} ${m.active ? '' : 'off'}"><div class="row between"><span class="code">${esc(m.code)}</span><span class="muted small">${m.mode === 'game' ? 'per game' : '1·2·3 min'}</span></div>
        <div><b>${esc(m.name)}</b></div>
        <div class="tm">${left != null && left > 0 ? mmss(left) : '--:--'}</div>
        <div class="muted small">${m.play_id && left > 0 ? `card ${esc(m.card_no || m.uid)} · ${m.minutes} min` : m.active ? 'free' : 'switched off'}</div>
        <a class="small" href="/station?machine=${encodeURIComponent(m.code)}" target="_blank">open station screen ↗</a></div>`;
    }).join('');
  } catch (e) { /* keep last board */ }
}
function startLive() { stopLive(); renderLive(); liveTimer = setInterval(renderLive, 3000); }
function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }

// ---------- reports ----------
function rangeDates(kind) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  if (kind === 'yesterday') { d.setDate(d.getDate() - 1); end.setDate(end.getDate() - 1); }
  if (kind === 'week') { const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); }
  if (kind === 'month') d.setDate(1);
  return [d, end];
}
const toInput = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
$$('#rangeSeg button').forEach(b => b.addEventListener('click', () => {
  $$('#rangeSeg button').forEach(x => x.classList.toggle('active', x === b));
  const [f, t] = rangeDates(b.dataset.range); $('#fromDate').value = toInput(f); $('#toDate').value = toInput(t); runReport();
}));
function currentRange() {
  if (!$('#fromDate').value) { const [f, t] = rangeDates('today'); $('#fromDate').value = toInput(f); $('#toDate').value = toInput(t); }
  const f = new Date($('#fromDate').value + 'T00:00:00'); const t = new Date(($('#toDate').value || $('#fromDate').value) + 'T23:59:59.999');
  return { from: f.toISOString(), to: t.toISOString() };
}
$('#runReport').addEventListener('click', runReport);
$('#exportCsv').addEventListener('click', () => { const { from, to } = currentRange(); window.open(`/api/reports/transactions?format=csv&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100000`); });
async function runReport() {
  const { from, to } = currentRange();
  const [sum, tx] = await Promise.all([api('GET', `/api/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), api('GET', `/api/reports/transactions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`)]);
  const t = sum.totals, L = sum.liabilities;
  const methodMap = Object.fromEntries(sum.by_method.map(m => [m.method, m.total]));
  $('#reportOut').innerHTML = `
    <div class="tiles">
      <div class="tile teal"><div class="l">Points sales</div><div class="v">${money(t.credit_sales)}</div><div class="s">${t.credits_sold ?? 0} points sold</div></div>
      <div class="tile"><div class="l">Deposits in / out</div><div class="v">${money(t.deposits_in)}</div><div class="s">${money(t.deposits_out)} refunded</div></div>
      <div class="tile"><div class="l">Points refunds</div><div class="v">${money(t.credit_refunds)}</div><div class="s">on returned cards</div></div>
      <div class="tile yellow"><div class="l">Net money in</div><div class="v">${money(t.net_cash_in)}</div><div class="s">cash ${money(methodMap.cash)} · card ${money(methodMap.card)} · online ${money(methodMap.online)}</div></div>
      <div class="tile"><div class="l">Plays</div><div class="v">${t.plays ?? 0}</div><div class="s">${t.credits_used ?? 0} points · ${t.minutes_played ?? 0} min</div></div>
      <div class="tile"><div class="l">Cards issued / returned</div><div class="v">${t.cards_issued ?? 0} / ${t.cards_returned ?? 0}</div><div class="s">${L.active_cards ?? 0} active cards overall</div></div>
      <div class="tile ink"><div class="l">Outstanding (liability)</div><div class="v">${money(L.credits_outstanding_value)}</div><div class="s">${L.credits_outstanding ?? 0} unused points · deposits held ${money(L.deposits_held)}</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card tight"><h3>By machine</h3><table><thead><tr><th>Machine</th><th class="num">Plays</th><th class="num">Points</th><th class="num">Minutes</th><th class="num">Value</th></tr></thead><tbody>
        ${sum.by_machine.map(m => `<tr><td><b>${esc(m.code)}</b> ${esc(m.name)}</td><td class="num">${m.plays}</td><td class="num">${m.credits}</td><td class="num">${m.minutes}</td><td class="num">${money(m.credits * state.settings.credit_price)}</td></tr>`).join('') || '<tr><td class="muted" colspan="5">No plays in this range</td></tr>'}</tbody></table></div>
      <div class="card tight"><h3>By package</h3><table><thead><tr><th>Package</th><th class="num">Sold</th><th class="num">Points</th><th class="num">Amount</th></tr></thead><tbody>
        ${sum.by_package.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.n}</td><td class="num">${p.credits}</td><td class="num">${money(p.amount)}</td></tr>`).join('') || '<tr><td class="muted" colspan="4">No sales in this range</td></tr>'}</tbody></table></div>
    </div>
    <div class="card tight"><h3>Transactions <span class="muted small">(latest 500 · export CSV for all)</span></h3><div class="scroll"><table><thead><tr><th>Time</th><th>Type</th><th>Card</th><th>Detail</th><th class="num">Points</th><th class="num">Bal</th><th class="num">Amount</th><th class="num">Deposit</th><th>Method</th><th>Staff</th></tr></thead><tbody>
      ${tx.map(r => `<tr class="${r.type}"><td class="small">${dtFull(r.ts)}</td><td>${r.type}</td><td>${esc(r.card_no || r.uid || '')}</td><td>${esc(r.note || r.machine_name || r.package_name || '')}</td><td class="num">${r.credits || ''}</td><td class="num">${r.balance_after ?? ''}</td><td class="num">${r.amount ? money(r.amount) : ''}</td><td class="num">${r.deposit ? money(r.deposit) : ''}</td><td>${r.method || ''}</td><td>${esc(r.staff || '')}</td></tr>`).join('') || '<tr><td class="muted" colspan="10">Nothing in this range</td></tr>'}</tbody></table></div></div>`;
}
$('#showShifts').addEventListener('click', async () => {
  const shifts = await api('GET', '/api/shifts');
  modal(`<h3>Shift history</h3><div class="scroll"><table><thead><tr><th>Staff</th><th>Opened</th><th>Closed</th><th class="num">Open cash</th><th class="num">Cash sales</th><th class="num">Card</th><th class="num">Online</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Diff</th></tr></thead><tbody>
    ${shifts.map(s => `<tr><td>${esc(s.staff)}</td><td class="small">${dtFull(s.opened_at)}</td><td class="small">${dtFull(s.closed_at)}</td><td class="num">${money(s.opening_cash)}</td><td class="num">${money(s.totals.by_method.cash)}</td><td class="num">${money(s.totals.by_method.card)}</td><td class="num">${money(s.totals.by_method.online)}</td><td class="num">${s.expected_cash != null ? money(s.expected_cash) : ''}</td><td class="num">${s.closing_cash != null ? money(s.closing_cash) : ''}</td><td class="num">${s.closing_cash != null ? money(s.closing_cash - s.expected_cash) : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="row end" style="margin-top:10px"><button class="btn" data-close>Close</button></div>`).el.querySelector('.modal').classList.add('wide');
});

// ---------- setup ----------
$('#unlockSetup').addEventListener('click', async () => { const pin = await askPin('Admin PIN to open Setup'); if (!pin) return; state.pin = pin; $('#setupLocked').classList.add('hidden'); $('#setupBody').classList.remove('hidden'); renderSetup(); });
function renderSetup() {
  const f = $('#settingsForm');
  for (const el of f.elements) if (el.name && el.name !== 'admin_pin' && state.settings[el.name] != null) el.value = state.settings[el.name];
  $('#pkgTable tbody').innerHTML = state.packages.map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.note || '')}</div></td><td class="num">${p.credits}</td><td class="num">${p.bonus}</td><td class="num">${money(p.price)}</td><td>${p.active ? '✓' : '—'}</td><td><button class="btn sm" data-pkg="${p.id}">Edit</button></td></tr>`).join('');
  $$('#pkgTable [data-pkg]').forEach(b => b.onclick = () => packageModal(state.packages.find(p => p.id === Number(b.dataset.pkg))));
  $('#machTable tbody').innerHTML = state.machines.map(m => `<tr class="${m.active ? '' : 'muted'}"><td><b>${esc(m.code)}</b></td><td>${esc(m.name)}<div class="muted small">${esc(m.note || '')}</div></td><td>${esc(m.zone || '')}</td><td>${m.mode}</td><td class="num">${m.price_1 ?? ''}</td><td class="num">${m.price_2 ?? ''}</td><td class="num">${m.price_3 ?? ''}</td><td class="num">${m.price_game ?? ''}</td><td>${m.active ? '✓' : '—'}</td><td><a class="small" href="/station?machine=${encodeURIComponent(m.code)}" target="_blank">/station?machine=${esc(m.code)}</a></td><td><button class="btn sm" data-mach="${m.id}">Edit</button></td></tr>`).join('');
  $$('#machTable [data-mach]').forEach(b => b.onclick = () => machineModal(state.machines.find(m => m.id === Number(b.dataset.mach))));
  renderUsers();
}
async function renderUsers() {
  const isAdmin = state.user?.role === 'admin';
  $('#addUser').classList.toggle('hidden', !isAdmin);
  $('#myPassword').classList.toggle('hidden', !state.user);
  if (!state.login_required) {
    $('#usersTable tbody').innerHTML = '<tr><td colspan="5" class="muted">No login is set up. On a public server set the POS_PASSWORD variable: that creates the <b>admin</b> user, then add staff here.</td></tr>';
    return;
  }
  if (!isAdmin) { $('#usersTable tbody').innerHTML = `<tr><td colspan="5" class="muted">Logged in as <b>${esc(state.user.username)}</b> (staff). Only admin can manage users.</td></tr>`; return; }
  try { state.users = await api('GET', '/api/users'); } catch (e) { toast(e.message, 'error'); return; }
  $('#usersTable tbody').innerHTML = state.users.map(u => `<tr class="${u.active ? '' : 'muted'}"><td><b>${esc(u.username)}</b></td><td>${u.role}</td><td>${u.active ? '✓' : '—'}</td><td class="small muted">${dt(u.last_login_at)}</td>
    <td class="row"><button class="btn sm" data-upw="${u.id}">Set password</button><button class="btn sm ${u.active ? 'danger' : 'green'}" data-uact="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
  $$('#usersTable [data-upw]').forEach(b => b.onclick = () => passwordModal(state.users.find(u => u.id === Number(b.dataset.upw))));
  $$('#usersTable [data-uact]').forEach(b => b.onclick = () => withPin(async pin => { await api('POST', `/api/users/${b.dataset.uact}/active`, { active: b.dataset.to === '1' }, pin); toast('Saved', 'ok'); renderUsers(); }));
}
$('#addUser').addEventListener('click', () => {
  modal(`<h3>Add user</h3><div class="fields">
    <div class="field"><label>User name (what they type to log in)</label><input id="uName" type="text" placeholder="e.g. priya or station" autocomplete="off"></div>
    <div class="field"><label>Role</label><select id="uRole"><option value="staff">Staff: sell, top-up, stations</option><option value="admin">Admin: also manage users</option></select></div>
    <div class="field"><label>Password</label><input id="uPw" type="text" autocomplete="off"></div></div>
    <p class="muted small">Give the user name and password to the staff member. They enter them in the browser's login box when they open the POS link.</p>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="uOk">Create</button></div>`,
    { onOpen: (el, close) => { $('#uName', el).focus(); $('#uOk', el).onclick = () => withPin(async pin => {
      await api('POST', '/api/users', { username: $('#uName', el).value, role: $('#uRole', el).value, password: $('#uPw', el).value }, pin);
      close(); toast('User created', 'ok'); renderUsers();
    }); } });
});
function passwordModal(u) {
  modal(`<h3>Set password for ${esc(u.username)}</h3><div class="field"><label>New password</label><input id="uPw" type="text" autocomplete="off"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="uOk">Save</button></div>`,
    { onOpen: (el, close) => { $('#uPw', el).focus(); $('#uOk', el).onclick = () => withPin(async pin => {
      await api('POST', `/api/users/${u.id}/password`, { password: $('#uPw', el).value }, pin); close(); toast('Password changed. They log in again with the new one.', 'ok', 6000);
    }); } });
}
$('#myPassword').addEventListener('click', () => {
  modal(`<h3>Change my password · ${esc(state.user?.username || '')}</h3>
    <div class="field"><label>Current password</label><input id="pOld" type="password"></div><div class="field"><label>New password</label><input id="pNew" type="password"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pOk">Change</button></div>`,
    { onOpen: (el, close) => { $('#pOld', el).focus(); $('#pOk', el).onclick = async () => {
      try { await api('POST', '/api/me/password', { old_password: $('#pOld', el).value, new_password: $('#pNew', el).value }); close(); toast('Password changed. The browser will ask you to log in again.', 'ok', 6000); }
      catch (e) { toast(e.message, 'error'); }
    }; } });
});
$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  const patch = {}; for (const el of e.target.elements) if (el.name && (el.name !== 'admin_pin' || el.value)) patch[el.name] = el.value;
  patch.setup_done = '1';
  withPin(async pin => { state.settings = await api('PUT', '/api/settings', patch, pin); if (patch.admin_pin) state.pin = patch.admin_pin; setCurrency(state.settings.currency); $('#brandName').textContent = state.settings.brand; $('#setupBanner').classList.add('hidden'); toast('Settings saved', 'ok'); e.target.elements.admin_pin.value = ''; });
});
$('#addPackage').addEventListener('click', () => packageModal(null));
$('#addMachine').addEventListener('click', () => machineModal(null));
function packageModal(p) {
  modal(`<h3>${p ? 'Edit' : 'New'} package</h3><div class="fields">
    <div class="field"><label>Name</label><input id="pName" type="text" value="${esc(p?.name ?? '')}"></div>
    <div class="field"><label>Points</label><input id="pCredits" type="number" value="${p?.credits ?? ''}"></div>
    <div class="field"><label>Bonus points</label><input id="pBonus" type="number" value="${p?.bonus ?? 0}"></div>
    <div class="field"><label>Price</label><input id="pPrice" type="number" step="0.01" value="${p?.price ?? ''}"></div>
    <div class="field"><label>Sort</label><input id="pSort" type="number" value="${p?.sort ?? 0}"></div>
    <div class="field"><label>Active</label><select id="pActive"><option value="1">Yes</option><option value="0" ${p && !p.active ? 'selected' : ''}>No</option></select></div></div>
    <div class="field"><label>Note shown to staff</label><input id="pNote" type="text" value="${esc(p?.note ?? '')}"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pOk">Save</button></div>`,
    { onOpen: (el, close) => { $('#pOk', el).onclick = () => withPin(async pin => {
      await api('POST', '/api/packages', { id: p?.id, name: $('#pName', el).value, credits: $('#pCredits', el).value, bonus: $('#pBonus', el).value, price: $('#pPrice', el).value, sort: $('#pSort', el).value, active: $('#pActive', el).value, note: $('#pNote', el).value }, pin);
      state.packages = await api('GET', '/api/packages'); close(); renderSetup(); toast('Package saved', 'ok');
    }); } });
}
function machineModal(m) {
  modal(`<h3>${m ? 'Edit' : 'New'} machine</h3><div class="fields">
    <div class="field"><label>Code (short, e.g. C1)</label><input id="mCode" type="text" value="${esc(m?.code ?? '')}"></div>
    <div class="field"><label>Name</label><input id="mName" type="text" value="${esc(m?.name ?? '')}"></div>
    <div class="field"><label>Zone</label><input id="mZone" type="text" value="${esc(m?.zone ?? '')}"></div>
    <div class="field"><label>Mode</label><select id="mMode"><option value="time" ${m?.mode !== 'game' ? 'selected' : ''}>Timed (1/2/3 min)</option><option value="game" ${m?.mode === 'game' ? 'selected' : ''}>Per game</option></select></div>
    <div class="field"><label>1 min (points)</label><input id="mP1" type="number" value="${m?.price_1 ?? ''}"></div>
    <div class="field"><label>2 min</label><input id="mP2" type="number" value="${m?.price_2 ?? ''}"></div>
    <div class="field"><label>3 min</label><input id="mP3" type="number" value="${m?.price_3 ?? ''}"></div>
    <div class="field"><label>Per game (points)</label><input id="mPG" type="number" value="${m?.price_game ?? ''}"></div>
    <div class="field"><label>Sort</label><input id="mSort" type="number" value="${m?.sort ?? 0}"></div>
    <div class="field"><label>Active</label><select id="mActive"><option value="1">Yes</option><option value="0" ${m && !m.active ? 'selected' : ''}>No</option></select></div></div>
    <div class="field"><label>Webhook when play starts (optional, e.g. http://192.168.1.50/relay/0?turn=on)</label><input id="mWS" type="url" value="${esc(m?.webhook_start ?? '')}"></div>
    <div class="field"><label>Webhook when play ends (optional)</label><input id="mWE" type="url" value="${esc(m?.webhook_stop ?? '')}"></div>
    <div class="field"><label>Note</label><input id="mNote" type="text" value="${esc(m?.note ?? '')}"></div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`,
    { onOpen: (el, close) => { $('#mOk', el).onclick = () => withPin(async pin => {
      await api('POST', '/api/machines', { id: m?.id, code: $('#mCode', el).value, name: $('#mName', el).value, zone: $('#mZone', el).value, mode: $('#mMode', el).value,
        price_1: $('#mP1', el).value, price_2: $('#mP2', el).value, price_3: $('#mP3', el).value, price_game: $('#mPG', el).value, sort: $('#mSort', el).value, active: $('#mActive', el).value,
        webhook_start: $('#mWS', el).value, webhook_stop: $('#mWE', el).value, note: $('#mNote', el).value }, pin);
      state.machines = await api('GET', '/api/machines'); close(); renderSetup(); toast('Machine saved', 'ok');
    }); } });
}

boot().catch(e => toast('Cannot reach server: ' + e.message, 'error', 10000));
