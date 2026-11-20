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
  assert.equal(data.packages.length, 3);
  assert.equal(data.settings.brand, 'Fun City');
  assert.equal(data.settings.admin_pin, undefined, 'PIN must not leak to clients');
});

test('shift open / close with expected cash', async () => {
  let r = await call('POST', '/api/shifts/open', { staff: 'Ayesha', opening_cash: 100 });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/shifts/open', { staff: 'Someone' });
  assert.equal(r.status, 409);
});

test('issue card with Fun package: 55 credits, price + deposit due', async () => {
  const r = await call('POST', '/api/cards/issue', { uid: '0001 2345', card_no: 'FC-001', holder_name: 'Omar', package_id: 2, method: 'cash' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.card.uid, '00012345');
  assert.equal(r.data.card.balance, 55);
  assert.equal(r.data.card.deposit, 10);
  assert.equal(r.data.total_due, 60);
  const dup = await call('POST', '/api/cards/issue', { uid: '00012345', package_id: 1 });
  assert.equal(dup.status, 409);
});

test('unknown card lookup returns found:false', async () => {
  const r = await call('GET', '/api/cards/ZZZZ9999');
  assert.equal(r.status, 200);
  assert.equal(r.data.found, false);
});

test('top-up with custom credits uses credit_price', async () => {
  const r = await call('POST', '/api/cards/00012345/topup', { credits: 10, method: 'card' });
  assert.equal(r.status, 200);
  assert.equal(r.data.card.balance, 65);
  assert.equal(r.data.total_due, 10);
});

test('play: basketball 3 min costs 4 credits, timer set, extend on second tap', async () => {
  let r = await call('POST', '/api/play', { uid: '00012345', machine: 'A', minutes: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.charged, 4);
  assert.equal(r.data.balance, 61);
  assert.equal(r.data.extended, false);
  const ends1 = new Date(r.data.play.ends_at).getTime();
  assert.ok(ends1 - Date.now() > 179_000 && ends1 - Date.now() <= 180_000);

  r = await call('POST', '/api/play', { uid: '00012345', machine: 'A', minutes: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.extended, true);
  assert.equal(new Date(r.data.play.ends_at).getTime(), ends1 + 60_000);
  assert.equal(r.data.play.minutes, 4);
  assert.equal(r.data.play.credits, 6);

  const live = await call('GET', '/api/machines/A/active');
  assert.equal(live.data.play.id, r.data.play.id);
});

test('machine busy with another card is refused', async () => {
  await call('POST', '/api/cards/issue', { uid: 'CARD2', package_id: 1, method: 'cash' });
  const r = await call('POST', '/api/play', { uid: 'CARD2', machine: 'A', minutes: 1 });
  assert.equal(r.status, 409);
});

test('per-game machine charges price_game and rejects when credits short', async () => {
  await call('POST', '/api/cards/issue', { uid: 'POOR1', credits: 2, method: 'cash' });
  let r = await call('POST', '/api/play', { uid: 'POOR1', machine: 'T' });   // toy catcher = 2 credits
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 0);
  r = await call('POST', '/api/play', { uid: 'POOR1', machine: 'H' });       // air hockey = 3 credits
  assert.equal(r.status, 402);
  assert.equal(r.data.needed, 3);
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
  assert.equal(r.data.card.balance, 22);
});

test('return card refunds deposit and unused credits', async () => {
  const r = await call('POST', '/api/cards/CARD2/return', { method: 'cash' }, { 'x-admin-pin': PIN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund_deposit, 10);
  assert.equal(r.data.refund_credits_money, 22);
  assert.equal(r.data.refund_total, 32);
  assert.equal(r.data.card.status, 'returned');
  const again = await call('POST', '/api/cards/CARD2/return', {}, { 'x-admin-pin': PIN });
  assert.equal(again.status, 410);
  // a returned card can be issued to a new customer
  const re = await call('POST', '/api/cards/issue', { uid: 'CARD2', package_id: 1, method: 'online' });
  assert.equal(re.status, 200);
  assert.equal(re.data.card.balance, 20);
});

test('report summary and CSV export are consistent', async () => {
  const r = await call('GET', '/api/reports/summary');
  assert.equal(r.status, 200);
  const t = r.data.totals;
  // sales: 50 (Fun) + 10 (custom) + 20 (Starter CARD2) + 2 (POOR1) + 20 (re-issue) = 102
  assert.equal(t.credit_sales, 102);
  assert.equal(t.credit_refunds, 22);
  assert.equal(t.deposits_in, 40);
  assert.equal(t.deposits_out, 10);
  assert.equal(t.credits_used, 8); // 4 + 2 + 2
  assert.ok(r.data.by_machine.find(m => m.code === 'A').credits === 6);
  const csv = await call('GET', '/api/reports/transactions?format=csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.data.replace(/^\uFEFF/, '').startsWith('company,id,ts,type'));
  assert.ok(csv.data.includes('FUNCITY,'));
});

test('close shift computes expected cash from cash-method transactions', async () => {
  const r = await call('POST', '/api/shifts/close', { closing_cash: 200 });
  assert.equal(r.status, 200);
  // cash in: 60 (issue) + 30 (CARD2 issue incl deposit) + 12 (POOR1) - 32 (return) = 70 ; opening 100 -> 170
  assert.equal(r.data.expected_cash, 170);
  assert.equal(r.data.totals.by_method.card, 10);
  assert.equal(r.data.totals.by_method.online, 30);
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
