// Business rules for the Fun City RFID POS. Every function takes the open db and plain data,
// and throws ApiError for anything the counter / station screen should show to staff.
import { getSettings } from './db.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const now = () => new Date().toISOString();
const METHODS = new Set(['cash', 'card', 'online']);

export function normalizeUid(uid) {
  const u = String(uid ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (u.length < 4 || u.length > 40) throw new ApiError(400, 'Card UID looks wrong. Tap the card again.');
  return u;
}

function money(v, field = 'amount') {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `Invalid ${field}.`);
  return Math.round(n * 100) / 100;
}
function intCredits(v, field = 'credits') {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ApiError(400, `Invalid ${field}.`);
  return n;
}
function method(v) {
  const m = String(v ?? 'cash').toLowerCase();
  if (!METHODS.has(m)) throw new ApiError(400, 'Payment method must be cash, card or online.');
  return m;
}

// ---------- settings ----------
export function settings(db) { return getSettings(db); }

export function publicSettings(db) {
  const s = getSettings(db);
  delete s.admin_pin;
  return s;
}

export function updateSettings(db, patch) {
  const allowed = new Set(Object.keys(getSettings(db)));
  const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue;
      if (k === 'credit_price' || k === 'card_deposit') money(v, k);
      if (k === 'admin_pin' && !/^\d{4,8}$/.test(String(v))) throw new ApiError(400, 'PIN must be 4–8 digits.');
      up.run(k, String(v));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return publicSettings(db);
}

export function checkPin(db, pin) {
  const s = getSettings(db);
  if (String(pin ?? '') !== s.admin_pin) throw new ApiError(403, 'Admin PIN required.');
}

// ---------- shifts ----------
export function currentShift(db) {
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() ?? null;
}

export function openShift(db, { staff, opening_cash }) {
  if (currentShift(db)) throw new ApiError(409, 'A shift is already open. Close it first.');
  if (!staff || !String(staff).trim()) throw new ApiError(400, 'Staff name is required.');
  const r = db.prepare('INSERT INTO shifts(staff, opened_at, opening_cash) VALUES (?,?,?)')
    .run(String(staff).trim(), now(), money(opening_cash ?? 0, 'opening cash'));
  return db.prepare('SELECT * FROM shifts WHERE id=?').get(r.lastInsertRowid);
}

export function shiftTotals(db, shiftId) {
  const rows = db.prepare(`SELECT method, SUM(amount + deposit) AS total FROM transactions WHERE shift_id=? GROUP BY method`).all(shiftId);
  const byMethod = { cash: 0, card: 0, online: 0 };
  for (const r of rows) if (r.method) byMethod[r.method] = Math.round((r.total ?? 0) * 100) / 100;
  const agg = db.prepare(`SELECT
      SUM(CASE WHEN type IN ('ISSUE','TOPUP') THEN credits ELSE 0 END) AS credits_sold,
      SUM(CASE WHEN type='PLAY' THEN -credits ELSE 0 END) AS credits_used,
      SUM(amount) AS sales, SUM(deposit) AS deposits,
      SUM(CASE WHEN type='ISSUE' THEN 1 ELSE 0 END) AS cards_issued,
      SUM(CASE WHEN type='RETURN' THEN 1 ELSE 0 END) AS cards_returned
    FROM transactions WHERE shift_id=?`).get(shiftId);
  return { by_method: byMethod, ...agg };
}

export function closeShift(db, { closing_cash, note }) {
  const s = currentShift(db);
  if (!s) throw new ApiError(409, 'No open shift.');
  const t = shiftTotals(db, s.id);
  const expected = Math.round((s.opening_cash + t.by_method.cash) * 100) / 100;
  db.prepare('UPDATE shifts SET closed_at=?, closing_cash=?, expected_cash=?, note=? WHERE id=?')
    .run(now(), money(closing_cash ?? 0, 'closing cash'), expected, note ?? null, s.id);
  return { ...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id), totals: t };
}

export function listShifts(db, limit = 30) {
  return db.prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT ?').all(limit)
    .map(s => ({ ...s, totals: shiftTotals(db, s.id) }));
}

// ---------- machines & packages ----------
export function listMachines(db, onlyActive = false) {
  return db.prepare(`SELECT * FROM machines ${onlyActive ? 'WHERE active=1' : ''} ORDER BY sort, code`).all();
}
export function getMachineByCode(db, code) {
  const m = db.prepare('SELECT * FROM machines WHERE code=?').get(String(code ?? '').trim().toUpperCase());
  if (!m) throw new ApiError(404, `Machine ${code} not found.`);
  return m;
}
export function saveMachine(db, data) {
  const code = String(data.code ?? '').trim().toUpperCase();
  if (!code || !data.name) throw new ApiError(400, 'Machine code and name are required.');
  const mode = data.mode === 'game' ? 'game' : 'time';
  const p = k => (data[k] === '' || data[k] == null ? null : intCredits(data[k], k));
  const fields = [data.name, data.zone ?? null, mode, p('price_1'), p('price_2'), p('price_3'), p('price_game'),
    data.active === false || data.active === 0 || data.active === '0' ? 0 : 1, Number(data.sort ?? 0),
    data.webhook_start || null, data.webhook_stop || null, data.note ?? null];
  if (data.id) {
    db.prepare(`UPDATE machines SET code=?, name=?, zone=?, mode=?, price_1=?, price_2=?, price_3=?, price_game=?, active=?, sort=?,
                webhook_start=?, webhook_stop=?, note=? WHERE id=?`).run(code, ...fields, data.id);
    return db.prepare('SELECT * FROM machines WHERE id=?').get(data.id);
  }
  const r = db.prepare(`INSERT INTO machines(code,name,zone,mode,price_1,price_2,price_3,price_game,active,sort,webhook_start,webhook_stop,note)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, ...fields);
  return db.prepare('SELECT * FROM machines WHERE id=?').get(r.lastInsertRowid);
}

export function listPackages(db, onlyActive = false) {
  return db.prepare(`SELECT * FROM packages ${onlyActive ? 'WHERE active=1' : ''} ORDER BY sort, id`).all();
}
export function savePackage(db, data) {
  if (!data.name) throw new ApiError(400, 'Package name is required.');
  const credits = intCredits(data.credits), bonus = intCredits(data.bonus ?? 0, 'bonus');
  if (credits <= 0 || bonus < 0) throw new ApiError(400, 'Points must be positive.');
  const price = money(data.price, 'price');
  const active = data.active === false || data.active === 0 || data.active === '0' ? 0 : 1;
  if (data.id) {
    db.prepare('UPDATE packages SET name=?, credits=?, bonus=?, price=?, active=?, sort=?, note=? WHERE id=?')
      .run(data.name, credits, bonus, price, active, Number(data.sort ?? 0), data.note ?? null, data.id);
    return db.prepare('SELECT * FROM packages WHERE id=?').get(data.id);
  }
  const r = db.prepare('INSERT INTO packages(name,credits,bonus,price,active,sort,note) VALUES (?,?,?,?,?,?,?)')
    .run(data.name, credits, bonus, price, active, Number(data.sort ?? 0), data.note ?? null);
  return db.prepare('SELECT * FROM packages WHERE id=?').get(r.lastInsertRowid);
}

// ---------- cards ----------
export function nextCardNumbers(db, count = 1) {
  // Reserve printed card numbers (the barcode value = the card UID), e.g. FC000001.
  const s = getSettings(db);
  count = Math.min(500, Math.max(1, Math.floor(Number(count) || 1)));
  const start = Math.max(1, Number(s.next_card_no) || 1);
  const digits = Math.min(12, Math.max(3, Number(s.card_digits) || 6));
  const prefix = String(s.card_prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(`${prefix}${String(start + i).padStart(digits, '0')}`);
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(start + count), 'next_card_no');
  return codes;
}

function cardRow(db, uid) {
  return db.prepare('SELECT * FROM cards WHERE uid=?').get(uid) ?? null;
}

export function getCard(db, rawUid, { history = 15 } = {}) {
  const uid = normalizeUid(rawUid);
  const card = cardRow(db, uid);
  if (!card) return { found: false, uid };
  const tx = db.prepare(`SELECT t.*, m.code AS machine_code, m.name AS machine_name, p.name AS package_name
                         FROM transactions t LEFT JOIN machines m ON m.id=t.machine_id LEFT JOIN packages p ON p.id=t.package_id
                         WHERE t.card_id=? ORDER BY t.id DESC LIMIT ?`).all(card.id, history);
  const active = db.prepare(`SELECT pl.*, m.code AS machine_code, m.name AS machine_name FROM plays pl JOIN machines m ON m.id=pl.machine_id
                             WHERE pl.card_id=? AND pl.status='running' AND pl.ends_at > ?`).all(card.id, now());
  return { found: true, card, transactions: tx, active_plays: active };
}

export function searchCards(db, q = '', limit = 50) {
  const like = `%${String(q).trim()}%`;
  return db.prepare(`SELECT * FROM cards WHERE uid LIKE ? OR card_no LIKE ? OR holder_name LIKE ? OR phone LIKE ?
                     ORDER BY last_used_at DESC, id DESC LIMIT ?`).all(like, like, like, like, limit);
}

function insertTx(db, t) {
  const r = db.prepare(`INSERT INTO transactions(ts,type,card_id,machine_id,package_id,shift_id,credits,amount,deposit,method,minutes,balance_after,staff,note)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(now(), t.type, t.card_id ?? null, t.machine_id ?? null, t.package_id ?? null, t.shift_id ?? null,
      t.credits ?? 0, t.amount ?? 0, t.deposit ?? 0, t.method ?? null, t.minutes ?? null, t.balance_after ?? null,
      t.staff ?? null, t.note ?? null);
  return db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid);
}

function resolvePurchase(db, data) {
  // Either a package (credits + bonus at package price) or custom credits at credit_price.
  const s = getSettings(db);
  if (data.package_id) {
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(Number(data.package_id));
    if (!p) throw new ApiError(404, 'Package not found.');
    return { credits: p.credits + p.bonus, amount: p.price, package_id: p.id, label: p.name };
  }
  const credits = intCredits(data.credits ?? 0);
  if (credits < 0) throw new ApiError(400, 'Credits cannot be negative.');
  const amount = data.amount != null && data.amount !== '' ? money(data.amount) : Math.round(credits * Number(s.credit_price) * 100) / 100;
  return { credits, amount, package_id: null, label: credits ? `${credits} points` : 'no points' };
}

export function issueCard(db, data) {
  const uid = normalizeUid(data.uid);
  const s = getSettings(db);
  const existing = cardRow(db, uid);
  if (existing && existing.status !== 'returned') throw new ApiError(409, 'This card is already issued. Use top-up instead.');
  const m = method(data.method);
  const deposit = data.deposit != null && data.deposit !== '' ? money(data.deposit, 'deposit') : Number(s.card_deposit);
  const buy = resolvePurchase(db, data);
  const shift = currentShift(db);
  db.exec('BEGIN');
  try {
    let cardId;
    if (existing) {
      // Re-issuing a returned card to a new customer.
      db.prepare(`UPDATE cards SET card_no=?, holder_name=?, phone=?, balance=?, deposit=?, status='active', issued_at=?, last_used_at=?, note=NULL WHERE id=?`)
        .run(data.card_no || existing.card_no, data.holder_name || null, data.phone || null, buy.credits, deposit, now(), now(), existing.id);
      cardId = existing.id;
    } else {
      const r = db.prepare('INSERT INTO cards(uid,card_no,holder_name,phone,balance,deposit,status,issued_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uid, data.card_no || null, data.holder_name || null, data.phone || null, buy.credits, deposit, 'active', now(), now());
      cardId = r.lastInsertRowid;
    }
    const tx = insertTx(db, { type: 'ISSUE', card_id: cardId, package_id: buy.package_id, shift_id: shift?.id, credits: buy.credits,
      amount: buy.amount, deposit, method: m, balance_after: buy.credits, staff: data.staff ?? shift?.staff, note: `New card · ${buy.label}` });
    db.exec('COMMIT');
    return { card: cardRow(db, uid), transaction: tx, total_due: Math.round((buy.amount + deposit) * 100) / 100 };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function requireActiveCard(db, rawUid) {
  const uid = normalizeUid(rawUid);
  const card = cardRow(db, uid);
  if (!card) throw new ApiError(404, 'Unknown card. Issue it at the counter first.', { uid });
  if (card.status === 'blocked') throw new ApiError(423, 'This card is blocked. Please see the counter.', { uid });
  if (card.status === 'returned') throw new ApiError(410, 'This card was returned. Issue it again at the counter.', { uid });
  return card;
}

export function topUp(db, rawUid, data) {
  const card = requireActiveCard(db, rawUid);
  const buy = resolvePurchase(db, data);
  if (buy.credits <= 0) throw new ApiError(400, 'Choose a package or enter points.');
  const m = method(data.method);
  const shift = currentShift(db);
  db.exec('BEGIN');
  try {
    const bal = card.balance + buy.credits;
    db.prepare('UPDATE cards SET balance=?, last_used_at=? WHERE id=?').run(bal, now(), card.id);
    const tx = insertTx(db, { type: 'TOPUP', card_id: card.id, package_id: buy.package_id, shift_id: shift?.id, credits: buy.credits,
      amount: buy.amount, method: m, balance_after: bal, staff: data.staff ?? shift?.staff, note: `Top-up · ${buy.label}` });
    db.exec('COMMIT');
    return { card: cardRow(db, card.uid), transaction: tx, total_due: buy.amount };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function adjustCredits(db, rawUid, data) {
  // Manual correction (e.g. machine failed mid-ride). No money moves. Admin PIN checked by the route.
  const card = requireActiveCard(db, rawUid);
  const credits = intCredits(data.credits);
  if (!credits) throw new ApiError(400, 'Enter a non-zero point change.');
  if (card.balance + credits < 0) throw new ApiError(400, 'Balance cannot go below zero.');
  const shift = currentShift(db);
  db.exec('BEGIN');
  try {
    const bal = card.balance + credits;
    db.prepare('UPDATE cards SET balance=? WHERE id=?').run(bal, card.id);
    const tx = insertTx(db, { type: 'ADJUST', card_id: card.id, shift_id: shift?.id, credits, balance_after: bal,
      staff: data.staff ?? shift?.staff, note: data.note || 'Manual adjustment' });
    db.exec('COMMIT');
    return { card: cardRow(db, card.uid), transaction: tx };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function setBlocked(db, rawUid, blocked, data = {}) {
  const uid = normalizeUid(rawUid);
  const card = cardRow(db, uid);
  if (!card) throw new ApiError(404, 'Unknown card.');
  if (card.status === 'returned') throw new ApiError(410, 'Card already returned.');
  const shift = currentShift(db);
  db.prepare('UPDATE cards SET status=?, note=? WHERE id=?').run(blocked ? 'blocked' : 'active', data.note ?? card.note, card.id);
  const tx = insertTx(db, { type: blocked ? 'BLOCK' : 'UNBLOCK', card_id: card.id, shift_id: shift?.id, balance_after: card.balance,
    staff: data.staff ?? shift?.staff, note: data.note || (blocked ? 'Card blocked (lost / misuse)' : 'Card unblocked') });
  return { card: cardRow(db, uid), transaction: tx };
}

export function returnCard(db, rawUid, data = {}) {
  // Customer hands the card back: refund the deposit and (by policy) any unused points.
  const uid = normalizeUid(rawUid);
  const card = cardRow(db, uid);
  if (!card) throw new ApiError(404, 'Unknown card.');
  if (card.status === 'returned') throw new ApiError(410, 'Card already returned.');
  const s = getSettings(db);
  const m = method(data.method);
  const refundCredits = data.refund_credits != null ? Boolean(data.refund_credits) : s.refund_credits_on_return === '1';
  const creditsBack = refundCredits ? card.balance : 0;
  const creditMoney = Math.round(creditsBack * Number(s.credit_price) * 100) / 100;
  const shift = currentShift(db);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE cards SET status='returned', balance=0, deposit=0, last_used_at=? WHERE id=?`).run(now(), card.id);
    const tx = insertTx(db, { type: 'RETURN', card_id: card.id, shift_id: shift?.id, credits: -card.balance, amount: -creditMoney,
      deposit: -card.deposit, method: m, balance_after: 0, staff: data.staff ?? shift?.staff,
      note: `Card returned · deposit ${card.deposit} back · ${creditsBack} points ${refundCredits ? 'refunded' : 'forfeited'}` });
    db.exec('COMMIT');
    return { card: cardRow(db, uid), transaction: tx, refund_total: Math.round((creditMoney + card.deposit) * 100) / 100,
      refund_deposit: card.deposit, refund_credits_money: creditMoney, credits_forfeited: refundCredits ? 0 : card.balance };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- plays (station screens) ----------
export function priceFor(machine, minutes) {
  if (machine.mode === 'game') return machine.price_game;
  const p = { 1: machine.price_1, 2: machine.price_2, 3: machine.price_3 }[minutes];
  return p == null ? null : p;
}

export function activePlay(db, machineId) {
  finishExpired(db);
  return db.prepare(`SELECT pl.*, c.uid, c.balance, c.card_no FROM plays pl JOIN cards c ON c.id=pl.card_id
                     WHERE pl.machine_id=? AND pl.status='running' ORDER BY pl.id DESC LIMIT 1`).get(machineId) ?? null;
}

export function finishExpired(db) {
  return db.prepare(`UPDATE plays SET status='done' WHERE status='running' AND ends_at <= ?`).run(now()).changes;
}

export function startPlay(db, data) {
  const machine = getMachineByCode(db, data.machine);
  if (!machine.active) throw new ApiError(409, `${machine.name} is switched off.`);
  const card = requireActiveCard(db, data.uid);
  const s = getSettings(db);
  const minutes = machine.mode === 'game' ? 0 : Number(data.minutes);
  if (machine.mode === 'time' && ![1, 2, 3].includes(minutes)) throw new ApiError(400, 'Pick 1, 2 or 3 minutes.');
  if (machine.mode === 'time' && minutes > Number(s.max_minutes)) throw new ApiError(400, `Max ${s.max_minutes} min per turn.`);
  const credits = priceFor(machine, minutes);
  if (credits == null) throw new ApiError(400, 'This machine has no price set. Ask staff.');
  if (card.balance < credits) {
    throw new ApiError(402, `Not enough points. Need ${credits}, card has ${card.balance}. Top up at the counter.`,
      { uid: card.uid, balance: card.balance, needed: credits });
  }
  const current = activePlay(db, machine.id);
  if (current && current.card_id !== card.id) {
    throw new ApiError(409, 'Machine is busy with another card. Wait for the timer.', { ends_at: current.ends_at });
  }
  const shift = currentShift(db);
  const startedAt = new Date();
  let endsAt;
  if (machine.mode === 'game') endsAt = new Date(startedAt.getTime() + 60_000); // 1 min window so the game can't be re-tapped by another card instantly
  else if (current) endsAt = new Date(new Date(current.ends_at).getTime() + minutes * 60_000); // same card: extend
  else endsAt = new Date(startedAt.getTime() + minutes * 60_000);

  db.exec('BEGIN');
  try {
    const bal = card.balance - credits;
    db.prepare('UPDATE cards SET balance=?, last_used_at=? WHERE id=?').run(bal, now(), card.id);
    const tx = insertTx(db, { type: 'PLAY', card_id: card.id, machine_id: machine.id, shift_id: shift?.id, credits: -credits,
      minutes: minutes || null, balance_after: bal, note: machine.mode === 'game' ? `${machine.name} · 1 game` : `${machine.name} · ${minutes} min` });
    let play;
    if (current && machine.mode === 'time') {
      db.prepare('UPDATE plays SET ends_at=?, minutes=minutes+?, credits=credits+? WHERE id=?').run(endsAt.toISOString(), minutes, credits, current.id);
      play = db.prepare('SELECT * FROM plays WHERE id=?').get(current.id);
    } else {
      const r = db.prepare('INSERT INTO plays(card_id,machine_id,tx_id,minutes,credits,started_at,ends_at) VALUES (?,?,?,?,?,?,?)')
        .run(card.id, machine.id, tx.id, minutes, credits, startedAt.toISOString(), endsAt.toISOString());
      play = db.prepare('SELECT * FROM plays WHERE id=?').get(r.lastInsertRowid);
    }
    db.exec('COMMIT');
    return { play, machine, card: cardRow(db, card.uid), charged: credits, extended: Boolean(current), balance: bal };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function stopPlay(db, playId) {
  const p = db.prepare('SELECT * FROM plays WHERE id=?').get(Number(playId));
  if (!p) throw new ApiError(404, 'Play not found.');
  if (p.status === 'running') db.prepare(`UPDATE plays SET status='stopped', ends_at=? WHERE id=?`).run(now(), p.id);
  return db.prepare('SELECT * FROM plays WHERE id=?').get(p.id);
}

export function liveBoard(db) {
  finishExpired(db);
  return db.prepare(`SELECT m.code, m.name, m.mode, m.active, pl.id AS play_id, pl.ends_at, pl.started_at, pl.minutes, c.card_no, c.uid
                     FROM machines m LEFT JOIN plays pl ON pl.machine_id=m.id AND pl.status='running'
                     LEFT JOIN cards c ON c.id=pl.card_id ORDER BY m.sort, m.code`).all();
}

// ---------- reports ----------
function range(from, to) {
  const f = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const t = to ? new Date(to) : new Date();
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new ApiError(400, 'Bad date range.');
  return [f.toISOString(), t.toISOString()];
}

export function reportSummary(db, { from, to } = {}) {
  const [f, t] = range(from, to);
  const totals = db.prepare(`SELECT
      SUM(CASE WHEN type IN ('ISSUE','TOPUP') THEN amount ELSE 0 END) AS credit_sales,
      SUM(CASE WHEN type='RETURN' THEN -amount ELSE 0 END) AS credit_refunds,
      SUM(CASE WHEN deposit>0 THEN deposit ELSE 0 END) AS deposits_in,
      SUM(CASE WHEN deposit<0 THEN -deposit ELSE 0 END) AS deposits_out,
      SUM(amount + deposit) AS net_cash_in,
      SUM(CASE WHEN type IN ('ISSUE','TOPUP') THEN credits ELSE 0 END) AS credits_sold,
      SUM(CASE WHEN type='PLAY' THEN -credits ELSE 0 END) AS credits_used,
      SUM(CASE WHEN type='PLAY' THEN COALESCE(minutes,0) ELSE 0 END) AS minutes_played,
      SUM(CASE WHEN type='PLAY' THEN 1 ELSE 0 END) AS plays,
      SUM(CASE WHEN type='ISSUE' THEN 1 ELSE 0 END) AS cards_issued,
      SUM(CASE WHEN type='RETURN' THEN 1 ELSE 0 END) AS cards_returned
    FROM transactions WHERE ts BETWEEN ? AND ?`).get(f, t);
  const byMethod = db.prepare(`SELECT method, SUM(amount + deposit) AS total, COUNT(*) AS n FROM transactions
                               WHERE ts BETWEEN ? AND ? AND method IS NOT NULL GROUP BY method`).all(f, t);
  const byMachine = db.prepare(`SELECT m.code, m.name, COUNT(*) AS plays, SUM(-t.credits) AS credits, SUM(COALESCE(t.minutes,0)) AS minutes
                                FROM transactions t JOIN machines m ON m.id=t.machine_id
                                WHERE t.type='PLAY' AND t.ts BETWEEN ? AND ? GROUP BY m.id ORDER BY credits DESC`).all(f, t);
  const byPackage = db.prepare(`SELECT COALESCE(p.name,'Custom points') AS name, COUNT(*) AS n, SUM(t.credits) AS credits, SUM(t.amount) AS amount
                                FROM transactions t LEFT JOIN packages p ON p.id=t.package_id
                                WHERE t.type IN ('ISSUE','TOPUP') AND t.ts BETWEEN ? AND ? GROUP BY p.id ORDER BY amount DESC`).all(f, t);
  const byHour = db.prepare(`SELECT substr(ts,12,2) AS hour_utc, SUM(CASE WHEN type='PLAY' THEN 1 ELSE 0 END) AS plays,
                             SUM(CASE WHEN type IN ('ISSUE','TOPUP') THEN amount ELSE 0 END) AS sales
                             FROM transactions WHERE ts BETWEEN ? AND ? GROUP BY hour_utc ORDER BY hour_utc`).all(f, t);
  const liabilities = db.prepare(`SELECT SUM(balance) AS credits_outstanding, SUM(deposit) AS deposits_held,
                                  SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_cards FROM cards WHERE status<>'returned'`).get();
  const s = getSettings(db);
  return { from: f, to: t, totals, by_method: byMethod, by_machine: byMachine, by_package: byPackage, by_hour: byHour,
    liabilities: { ...liabilities, credits_outstanding_value: Math.round((liabilities.credits_outstanding ?? 0) * Number(s.credit_price) * 100) / 100 } };
}

export function reportTransactions(db, { from, to, type, limit = 2000 } = {}) {
  const [f, t] = range(from, to);
  const where = ['t.ts BETWEEN ? AND ?'];
  const args = [f, t];
  if (type) { where.push('t.type=?'); args.push(String(type).toUpperCase()); }
  args.push(Number(limit));
  return db.prepare(`SELECT t.*, c.uid, c.card_no, c.holder_name, m.code AS machine_code, m.name AS machine_name, p.name AS package_name
                     FROM transactions t LEFT JOIN cards c ON c.id=t.card_id LEFT JOIN machines m ON m.id=t.machine_id
                     LEFT JOIN packages p ON p.id=t.package_id
                     WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`).all(...args);
}

export function toCsv(rows, companyCode) {
  const cols = ['id', 'ts', 'type', 'card_no', 'uid', 'holder_name', 'machine_code', 'machine_name', 'package_name',
    'minutes', 'credits', 'balance_after', 'amount', 'deposit', 'method', 'shift_id', 'staff', 'note'];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['company', ...cols].join(',')];
  for (const r of rows) lines.push([companyCode, ...cols.map(c => esc(r[c]))].join(','));
  return lines.join('\n') + '\n';
}
