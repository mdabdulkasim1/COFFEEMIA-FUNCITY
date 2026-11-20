// Station screen: one per machine (tablet / small PC with a USB RFID reader).
// URL: /station?machine=C1   add &auto=1 to start 1 minute (or 1 game) straight away on scan, without buttons.
import { $, $$, esc, api, mmss, beep, toast } from './common.js';
import { attachScanner } from './scan.js';

const qs = new URLSearchParams(location.search);
const CODE = (qs.get('machine') || localStorage.getItem('station.machine') || '').toUpperCase();
const AUTO = qs.get('auto') === '1';
const app = $('#app');

let settings = {}, machine = null, skew = 0;
let st = { mode: 'idle', card: null, play: null, until: 0, msg: '' };
let chooseTimer = null, tickTimer = null;

const serverNow = () => Date.now() - skew;

async function boot() {
  const b = await api('GET', '/api/bootstrap');
  settings = b.settings; skew = Date.now() - new Date(b.server_time).getTime();
  if (!CODE) return chooser(b.machines);
  machine = b.machines.find(m => m.code === CODE);
  if (!machine) return chooser(b.machines, `No machine with code ${CODE}`);
  localStorage.setItem('station.machine', CODE);
  document.title = `${machine.code} · ${machine.name}`;
  await sync();
  setInterval(sync, 5000);
  tickTimer = setInterval(render, 250);
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch { /* optional */ }
  render();
}

function chooser(machines, err) {
  app.innerHTML = `<div class="chooser"><h1>Choose the machine for this screen</h1>${err ? `<p class="msg err">${esc(err)}</p>` : ''}
    ${machines.filter(m => m.active).map(m => `<a href="/station?machine=${encodeURIComponent(m.code)}"><b>${esc(m.code)}</b>${esc(m.name)} <span style="float:right;opacity:.7">${m.mode === 'game' ? `${m.price_game} cr / game` : `${m.price_1}·${m.price_2}·${m.price_3} cr`}</span></a>`).join('')}</div>`;
}

async function sync() {
  try {
    const r = await api('GET', `/api/machines/${encodeURIComponent(CODE)}/active`);
    skew = Date.now() - new Date(r.server_time).getTime();
    machine = r.machine;
    if (r.play && new Date(r.play.ends_at).getTime() > serverNow()) {
      if (st.mode === 'idle' || st.mode === 'done' || (st.mode === 'running' && st.play?.id !== r.play.id)) st = { mode: 'running', play: r.play, card: { uid: r.play.uid, balance: r.play.balance, card_no: r.play.card_no } };
      else if (st.mode === 'running') st.play = r.play;
    } else if (st.mode === 'running') finish();
  } catch { /* offline: keep showing local state */ }
}

attachScanner(onTap);
$('#manualUid').addEventListener('keydown', e => { if (e.key === 'Enter') { onTap(e.target.value.trim().toUpperCase()); e.target.value = ''; } });

async function onTap(uid) {
  if (!machine) return;
  try {
    const r = await api('GET', `/api/cards/${encodeURIComponent(uid)}`);
    if (!r.found) return fail('Card not issued. Please go to the counter.');
    if (r.card.status !== 'active') return fail(r.card.status === 'blocked' ? 'Card blocked. Please see the counter.' : 'Card returned. Please see the counter.');
    beep('ok');
    if (st.mode === 'running' && st.play && st.play.card_id !== r.card.id) return fail('Machine busy. Please wait for the timer.');
    if (AUTO) return start(r.card.uid, machine.mode === 'game' ? 0 : 1);
    setMode('choose', { card: r.card, play: st.mode === 'running' ? st.play : null });
    clearTimeout(chooseTimer);
    chooseTimer = setTimeout(() => { if (st.mode === 'choose') st.play && remaining() > 0 ? setMode('running', { play: st.play, card: st.card }) : setMode('idle'); }, Number(settings.choose_timeout_sec || 25) * 1000);
  } catch (e) { fail(e.message); }
}

async function start(uid, minutes) {
  try {
    const r = await api('POST', '/api/play', { uid, machine: CODE, minutes });
    beep('start'); clearTimeout(chooseTimer);
    setMode(machine.mode === 'game' ? 'go' : 'running', { play: r.play, card: r.card, msg: r.extended ? `+${minutes} min added · ${r.charged} points` : `${r.charged} points taken · balance ${r.balance}` });
    if (machine.mode === 'game') setTimeout(() => { if (st.mode === 'go') setMode('idle'); }, 6000);
  } catch (e) { fail(e.message); }
}

function fail(msg) {
  beep('error');
  const back = st.mode === 'running' ? { mode: 'running', play: st.play, card: st.card } : { mode: 'idle' };
  st = { ...back, msg }; render();
  setTimeout(() => { if (st.msg === msg) { st.msg = ''; render(); } }, 4000);
}
function setMode(mode, extra = {}) { st = { mode, card: st.card, play: st.play, msg: '', ...extra }; render(); }
function remaining() { return st.play ? (new Date(st.play.ends_at).getTime() - serverNow()) / 1000 : 0; }
function finish() { beep('done'); setMode('done'); setTimeout(() => { if (st.mode === 'done') setMode('idle'); }, 8000); }

function render() {
  if (!machine) return;
  const rem = remaining();
  if (st.mode === 'running' && rem <= 0) return finish();
  const isGame = machine.mode === 'game';
  const head = `<div class="st-top"><div><span class="code">${esc(machine.code)}</span> &nbsp; <span class="name">${esc(machine.name)}</span></div><div class="muted small" style="color:#fff;opacity:.6">${esc(settings.brand || '')} · ${isGame ? `${machine.price_game} points per game` : `${machine.price_1} · ${machine.price_2} · ${machine.price_3} points`}</div></div>`;
  const foot = `<div class="st-foot"><span>Prepaid card only · points are taken when the timer starts</span><span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`;
  let body = '';
  if (st.mode === 'idle') {
    body = `<div class="headline">Scan your card to play</div>
      <div class="lcd"><div><div class="l">BALANCE</div><div class="v">--</div></div><div class="r"><div class="l">TIME LEFT</div><div class="v">--:--</div></div></div>
      ${isGame ? `<div class="scan pulse">📶 Scan card here · ${machine.price_game} points per game</div>` : `<div class="mins">${minsButtons(true)}</div><div class="scan pulse">📶 Scan card here</div>`}
      <div class="msg ${st.msg ? 'err' : ''}">${esc(st.msg)}</div>`;
  } else if (st.mode === 'choose') {
    const c = st.card;
    body = `<div class="headline">${st.play && rem > 0 ? 'Add more time' : isGame ? 'Ready to play?' : 'Pick your minutes'}</div>
      <div class="lcd"><div><div class="l">BALANCE</div><div class="v">${c.balance} <span style="font-size:1.2rem">pts</span></div></div><div class="r"><div class="l">TIME LEFT</div><div class="v">${st.play && rem > 0 ? mmss(rem) : '--:--'}</div></div></div>
      ${isGame ? `<div class="mins"><button id="go" ${c.balance < machine.price_game ? 'disabled' : ''}>PLAY<small>${machine.price_game} points</small></button></div>` : `<div class="mins">${minsButtons(false, c.balance)}</div>`}
      <div class="msg">${c.balance < (isGame ? machine.price_game : machine.price_1) ? '<span class="err">Not enough points · top up at the counter</span>' : 'Card ' + esc(c.card_no || '')}</div>`;
  } else if (st.mode === 'running') {
    const total = Math.max(1, st.play.minutes * 60);
    body = `<div class="headline go">Playing · enjoy!</div>
      <div class="lcd"><div><div class="l">BALANCE</div><div class="v">${st.card?.balance ?? '--'} <span style="font-size:1.2rem">pts</span></div></div><div class="r"><div class="l">TIME LEFT</div><div class="v big">${mmss(rem)}</div></div></div>
      <div class="progress"><i style="width:${Math.min(100, rem / total * 100)}%"></i></div>
      <div class="scan">📶 Scan the same card again to add time</div>
      <div class="msg ${st.msg ? (st.msg.includes('points') ? 'ok' : 'err') : ''}">${esc(st.msg)}</div>`;
  } else if (st.mode === 'go') {
    body = `<div class="headline go">GO! Have fun 🎉</div><div class="lcd"><div><div class="l">BALANCE</div><div class="v">${st.card?.balance ?? '--'} <span style="font-size:1.2rem">pts</span></div></div><div class="r"><div class="l">GAME</div><div class="v">ON</div></div></div><div class="msg ok">${esc(st.msg)}</div>`;
  } else if (st.mode === 'done') {
    body = `<div class="headline up">⏰ Time up!</div><div class="lcd"><div><div class="l">BALANCE</div><div class="v">${st.card?.balance ?? '--'} <span style="font-size:1.2rem">pts</span></div></div><div class="r"><div class="l">TIME LEFT</div><div class="v big">00:00</div></div></div><div class="scan pulse">📶 Scan card to play again</div>`;
  }
  app.innerHTML = head + `<div class="st-main">${body}</div>` + foot;
  $$('.mins button[data-min]').forEach(b => b.onclick = () => start(st.card.uid, Number(b.dataset.min)));
  $('#go')?.addEventListener('click', () => start(st.card.uid, 0));
}
function minsButtons(disabled, balance = 0) {
  const max = Number(settings.max_minutes || 3);
  return [1, 2, 3].filter(m => m <= max).map(m => { const p = machine[`price_${m}`]; return `<button data-min="${m}" class="${m === 3 ? 'best' : ''}" ${disabled || p == null || balance < p ? 'disabled' : ''}>${m} MIN<small>${p ?? '—'} points</small></button>`; }).join('');
}

boot().catch(e => { app.innerHTML = `<div class="chooser"><h1>Cannot reach the POS server</h1><p>${esc(e.message)}</p></div>`; });
