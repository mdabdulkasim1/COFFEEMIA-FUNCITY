// Shared helpers for the counter POS and the station screens.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ApiError extends Error { constructor(status, data) { super(data?.error || `HTTP ${status}`); this.status = status; this.data = data; } }

export async function api(method, path, body, pin) {
  const headers = { 'content-type': 'application/json' };
  if (pin) headers['x-admin-pin'] = pin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let CUR = '';
export const setCurrency = c => { CUR = c || ''; };
export const money = v => `${CUR} ${Number(v ?? 0).toFixed(2)}`.trim();
export const dt = iso => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const dtFull = iso => iso ? new Date(iso).toLocaleString() : '—';
export const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

export function toast(msg, kind = 'info', ms = 3200) {
  let host = $('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// Short beeps so staff and kids get audible feedback from the reader.
let actx;
export function beep(kind = 'ok') {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const seq = kind === 'ok' ? [[880, 0.08]] : kind === 'start' ? [[660, 0.08], [990, 0.12]] : kind === 'done' ? [[523, 0.12], [392, 0.2]] : [[220, 0.25]];
    let t = actx.currentTime;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.value = 0.08;
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d); t += d + 0.03;
    }
  } catch { /* audio not available */ }
}

export function modal(html, { onOpen } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  $$('[data-close]', back).forEach(b => b.addEventListener('click', close));
  onOpen?.(back, close);
  return { el: back, close };
}

export function askPin(message = 'Enter admin PIN') {
  return new Promise(resolve => {
    const m = modal(`<h3>${esc(message)}</h3><input id="pinIn" type="password" inputmode="numeric" class="big" autocomplete="off" placeholder="PIN">
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pinOk">OK</button></div>`,
      { onOpen: (el, close) => {
        const inp = $('#pinIn', el); inp.focus();
        const done = async () => {
          try { await api('POST', '/api/pin/check', { pin: inp.value }); close(); resolve(inp.value); }
          catch { toast('Wrong PIN', 'error'); inp.value = ''; inp.focus(); }
        };
        $('#pinOk', el).onclick = done;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); done(); } });
        el.addEventListener('click', e => { if (e.target === el) resolve(null); });
        $('[data-close]', el).addEventListener('click', () => resolve(null));
      } });
  });
}
