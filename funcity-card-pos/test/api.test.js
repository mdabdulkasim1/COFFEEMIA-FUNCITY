import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let app, base;
const PIN = '1234';
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

before(async () => {
  app = createApp(':memory:');
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

test('bootstrap seeds machines, packages and settings', async () => {
  const { status, data } = await call('GET', '/api/bootstrap');
  assert.equal(status, 200);
  assert.ok(data.machines.length >= 12);
  assert.equal(data.packages.length, 4);
  assert.equal(data.settings.currency, '₹');
  assert.equal(data.settings.card_deposit, '0');
  assert.equal(data.settings.brand, 'Coffeemia Kids Play Zone');
  assert.equal(data.settings.admin_pin, undefined, 'PIN must not leak to clients');
});

test('shift open / close with expected cash', async () => {
  let r = await call('POST', '/api/shifts/open', { staff: 'Ayesha', opening_cash: 100 });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/shifts/open', { staff: 'Someone' });
  assert.equal(r.status, 409);
});

test('issue card with 100-point package: 100 points, price + optional deposit due', async () => {
  const r = await call('POST', '/api/cards/issue', { uid: '0001 2345', card_no: 'FC-001', holder_name: 'Omar', package_id: 2, method: 'cash', deposit: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.uid, '00012345');
  assert.equal(r.data.card.balance, 100);
  assert.equal(r.data.card.deposit, 10);
  assert.equal(r.data.total_due, 110);
  const dup = await call('POST', '/api/cards/issue', { uid: '00012345', package_id: 1 });
  assert.equal(dup.status, 409);
});

test('unknown card lookup returns found:false', async () => {
  const r = await call('GET', '/api/cards/ZZZZ9999');
  assert.equal(r.status, 200);
  assert.equal(r.data.found, false);
});

test('top-up with custom points uses credit_price (₹1 = 1 point)', async () => {
  const r = await call('POST', '/api/cards/00012345/topup', { credits: 10, method: 'card' });
  assert.equal(r.status, 200);
  assert.equal(r.data.card.balance, 110);
  assert.equal(r.data.total_due, 10);
});

test('play: basketball 3 min costs 40 points, timer set, extend on second scan', async () => {
  let r = await call('POST', '/api/play', { uid: '00012345', machine: 'A', minutes: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.charged, 40);
  assert.equal(r.data.balance, 70);
  assert.equal(r.data.extended, false);
  const ends1 = new Date(r.data.play.ends_at).getTime();
  assert.ok(ends1 - Date.now() > 179_000 && ends1 - Date.now() <= 180_000);

  r = await call('POST', '/api/play', { uid: '00012345', machine: 'A', minutes: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.extended, true);
  assert.equal(new Date(r.data.play.ends_at).getTime(), ends1 + 60_000);
  assert.equal(r.data.play.minutes, 4);
  assert.equal(r.data.play.credits, 60);

  const live = await call('GET', '/api/machines/A/active');
  assert.equal(live.data.play.id, r.data.play.id);
});

test('machine busy with another card is refused', async () => {
  await call('POST', '/api/cards/issue', { uid: 'CARD2', package_id: 1, method: 'cash' });
  const r = await call('POST', '/api/play', { uid: 'CARD2', machine: 'A', minutes: 1 });
  assert.equal(r.status, 409);
});

test('per-game machine charges price_game and rejects when points short', async () => {
  await call('POST', '/api/cards/issue', { uid: 'POOR1', credits: 20, method: 'cash' });
  let r = await call('POST', '/api/play', { uid: 'POOR1', machine: 'T' });   // toy catcher = 20 points
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 0);
  r = await call('POST', '/api/play', { uid: 'POOR1', machine: 'H' });       // air hockey = 30 points
  assert.equal(r.status, 402);
  assert.equal(r.data.needed, 30);
});

test('bad minutes / unknown card / blocked card', async () => {
  let r = await call('POST', '/api/play', { uid: '00012345', machine: 'B', minutes: 5 });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/play', { uid: 'NOPE1234', machine: 'B', minutes: 1 });
  assert.equal(r.status, 404);
  await call('POST', '/api/cards/CARD2/block', { note: 'lost' });
  r = await call('POST', '/api/play', { uid: 'CARD2', machine: 'B', minutes: 1 });
  assert.equal(r.status, 423);
  r = await call('POST', '/api/cards/CARD2/unblock', {});
  assert.equal(r.status, 403, 'unblock needs PIN');
  r = await call('POST', '/api/cards/CARD2/unblock', {}, { 'x-admin-pin': PIN });
  assert.equal(r.status, 200);
  assert.equal(r.data.card.status, 'active');
});

test('adjust needs PIN and cannot go negative', async () => {
  let r = await call('POST', '/api/cards/CARD2/adjust', { credits: -5, note: 'ride failed' });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/cards/CARD2/adjust', { credits: -500 }, { 'x-admin-pin': PIN });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/cards/CARD2/adjust', { credits: 2, note: 'ride failed' }, { 'x-admin-pin': PIN });
  assert.equal(r.status, 200);
  assert.equal(r.data.card.balance, 52);
});

test('return card refunds deposit (if any) and unused points', async () => {
  const r = await call('POST', '/api/cards/CARD2/return', { method: 'cash' }, { 'x-admin-pin': PIN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund_deposit, 0);
  assert.equal(r.data.refund_credits_money, 52);
  assert.equal(r.data.refund_total, 52);
  assert.equal(r.data.card.status, 'returned');
  const again = await call('POST', '/api/cards/CARD2/return', {}, { 'x-admin-pin': PIN });
  assert.equal(again.status, 410);
  // a returned card can be issued to a new customer
  const re = await call('POST', '/api/cards/issue', { uid: 'CARD2', package_id: 1, method: 'online' });
  assert.equal(re.status, 200);
  assert.equal(re.data.card.balance, 50);
});

test('report summary and CSV export are consistent', async () => {
  const r = await call('GET', '/api/reports/summary');
  assert.equal(r.status, 200);
  const t = r.data.totals;
  // sales: 100 + 10 (custom) + 50 (CARD2) + 20 (POOR1) + 50 (re-issue) = 230
  assert.equal(t.credit_sales, 230);
  assert.equal(t.credit_refunds, 52);
  assert.equal(t.deposits_in, 10);
  assert.equal(t.deposits_out, 0);
  assert.equal(t.credits_used, 80); // 40 + 20 + 20
  assert.ok(r.data.by_machine.find(m => m.code === 'A').credits === 60);
  const csv = await call('GET', '/api/reports/transactions?format=csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.data.replace(/^\uFEFF/, '').startsWith('company,id,ts,type'));
  assert.ok(csv.data.includes('FUNCITY,'));
});

test('close shift computes expected cash from cash-method transactions', async () => {
  const r = await call('POST', '/api/shifts/close', { closing_cash: 200 });
  assert.equal(r.status, 200);
  // cash in: 110 (issue incl deposit) + 50 (CARD2) + 20 (POOR1) - 52 (return) = 128 ; opening 100 -> 228
  assert.equal(r.data.expected_cash, 228);
  assert.equal(r.data.totals.by_method.card, 10);
  assert.equal(r.data.totals.by_method.online, 50);
});

test('settings update requires PIN and hides it afterwards', async () => {
  let r = await call('PUT', '/api/settings', { brand: 'X' });
  assert.equal(r.status, 403);
  r = await call('PUT', '/api/settings', { brand: 'Coffeemia Fun City', credit_price: 2, setup_done: 1 }, { 'x-admin-pin': PIN });
  assert.equal(r.status, 200);
  assert.equal(r.data.brand, 'Coffeemia Fun City');
  assert.equal(r.data.admin_pin, undefined);
  r = await call('POST', '/api/pin/check', { pin: '0000' });
  assert.equal(r.status, 403);
});

test('card number generator reserves sequential printed numbers', async () => {
  let r = await call('POST', '/api/cards/next', { count: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.codes, ['CK000001', 'CK000002', 'CK000003']);
  r = await call('POST', '/api/cards/next', {});
  assert.deepEqual(r.data.codes, ['CK000004']);
  // a printed number works as the card UID straight away
  r = await call('POST', '/api/cards/issue', { uid: 'CK000004', card_no: 'CK000004', package_id: 1, method: 'cash' });
  assert.equal(r.status, 200);
  assert.equal(r.data.card.balance, 50);
  assert.equal(r.data.total_due, 50);
});

test('Code 128 encoder: valid structure and checksum', async () => {
  const { code128Values, code128Widths, code128Svg } = await import('../public/js/barcode.js');
  const v = code128Values('FC000123');
  assert.equal(v[0], 104); assert.equal(v.at(-1), 106);
  const sum = 104 + [...'FC000123'].reduce((a, ch, i) => a + (ch.charCodeAt(0) - 32) * (i + 1), 0);
  assert.equal(v.at(-2), sum % 103);
  const w = code128Widths('FC000123');
  assert.equal(w.length, (v.length - 1) * 6 + 7);
  assert.ok(code128Svg('FC000123').includes('<svg'));
  assert.throws(() => code128Values('bad\u00e9'));
});

test('POS_PASSWORD protects every route with Basic auth', async () => {
  process.env.POS_PASSWORD = 'secret9';
  const { createApp } = await import('../server/index.js?pw=' + Date.now());
  const a = createApp(':memory:');
  await new Promise(r => a.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  try {
    let res = await fetch(b + '/api/bootstrap');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Basic/);
    res = await fetch(b + '/');
    assert.equal(res.status, 401);
    res = await fetch(b + '/api/bootstrap', { headers: { authorization: 'Basic ' + Buffer.from('staff:secret9').toString('base64') } });
    assert.equal(res.status, 200);
    res = await fetch(b + '/api/bootstrap', { headers: { authorization: 'Basic ' + Buffer.from('staff:wrong').toString('base64') } });
    assert.equal(res.status, 401);
  } finally { a.close(); delete process.env.POS_PASSWORD; }
});
