// RFID keyboard-wedge capture.
// USB RFID readers (incl. the "RFID POS USB reader" in the supplier list) act like a keyboard: they type the
// card UID very fast and usually press Enter. We detect that burst anywhere on the page, so staff never has to
// click into a box first. A human typing is far slower, so normal form entry is left alone.
export function attachScanner(onScan, { minLength = 4, maxGapMs = 120, settleMs = 250, burstMin = 8 } = {}) {
  let buf = '', last = 0, settle = null;

  const fire = () => {
    clearTimeout(settle); settle = null;
    const uid = buf; buf = '';
    if (uid.length < minLength) return;
    // If the burst landed inside a focused text box, remove it from there.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value.endsWith(uid) && !el.dataset.scanTarget) {
      el.value = el.value.slice(0, -uid.length);
    }
    onScan(uid.toUpperCase());
  };

  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const now = performance.now();
    if (e.key === 'Enter') {
      if (buf.length >= minLength && now - last <= maxGapMs * 3) { e.preventDefault(); e.stopPropagation(); fire(); }
      else buf = '';
      return;
    }
    if (e.key.length !== 1) return;                       // ignore Shift, Tab, arrows…
    if (now - last > maxGapMs) buf = '';                   // too slow: it's a person typing
    buf += e.key; last = now;
    if (document.activeElement?.dataset?.scanTarget) e.preventDefault(); // keep the tap box clean
    clearTimeout(settle);
    settle = setTimeout(() => { if (buf.length >= burstMin) fire(); else buf = ''; }, settleMs); // readers without Enter
  }, true);
}
