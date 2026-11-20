// SQLite storage for the Fun City RFID POS.
// Uses Node's built-in node:sqlite (Node >= 22.5) so the venue PC needs no npm install.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = {
  brand: 'Coffeemia Kids Play Zone',
  company_code: 'FUNCITY',          // tag used in exports so the group accounts can pick it up
  currency: '₹',
  credit_price: '1',                // rupees per 1 point (₹100 paid = 100 points)
  card_deposit: '0',                // refundable deposit per card (0 = none)
  refund_credits_on_return: '1',    // 1 = pay back unused points when a card is returned
  card_prefix: 'CK',                // printed card numbers: CK000001, CK000002 …
  card_digits: '6',
  next_card_no: '1',                // next number the POS will print / generate
  max_minutes: '3',
  choose_timeout_sec: '25',         // station screen: seconds to pick minutes before going idle
  admin_pin: '1234',                // guards setup, adjustments, refunds and returns
  receipt_header: '',               // e.g. address / phone printed under the brand
  receipt_footer: 'Prepaid only. Points are taken when the timer starts. Keep your card safe.',
  setup_done: '0',
};

// Machines from the floor plan (zones A–G) mapped to the supplier's equipment list.
// Point prices are placeholders at ₹1 = 1 point: edit them in Setup → Machines.
const SEED_MACHINES = [
  ['A',  'Kids Basketball Machine', 'A',  'time', 20, 30, 40, null, 'Supplier item 8 · 154×81×190 cm · 150 kg'],
  ['B',  'Ball Throw',              'B',  'time', 10, 20, 30, null, 'Target wall 5\'0" × 2\'6"'],
  ['C1', '3D Motor Bike',           'C',  'time', 10, 20, 30, null, 'Supplier item 4 · 120×70×150 cm · 65 kg'],
  ['C2', '3D Classic Car',          'C',  'time', 10, 20, 30, null, 'Supplier item 5 · 120×70×150 cm · 65 kg'],
  ['C3', 'Scooter Ride',            'C',  'time', 10, 20, 30, null, ''],
  ['C4', '3D Video Horse Ride',     'C',  'time', 10, 20, 30, null, 'Supplier item 3 · 120×70×150 cm · 60 kg'],
  ['D1', 'RC Racing · Driver 1',    'D',  'time', 20, 40, 50, null, 'RC track station 1'],
  ['D2', 'RC Racing · Driver 2',    'D',  'time', 20, 40, 50, null, 'RC track station 2'],
  ['D3', 'RC Racing · Driver 3',    'D',  'time', 20, 40, 50, null, 'RC track station 3'],
  ['D4', 'RC Racing · Driver 4',    'D',  'time', 20, 40, 50, null, 'RC track station 4'],
  ['G',  'Hit A Frog (Whack-a-mole)','G', 'time', 10, 20, 30, null, 'Supplier item 2 · 115×93×145 cm · 85 kg · 2 player'],
  ['H',  'Air Hockey',              'H',  'game', null, null, null, 30, 'Supplier item 6 · 163×88×73 cm · 150 kg · per game'],
  ['T',  'Toy Catcher',             'T',  'game', null, null, null, 20, 'Supplier item 7 · 95×82×210 cm · 85 kg · per play'],
];

// ₹1 = 1 point. Add bonus points in Setup if you want offers like 75 points for ₹50.
const SEED_PACKAGES = [
  ['50 points',  50,  0, 50,  ''],
  ['100 points', 100, 0, 100, 'most popular'],
  ['200 points', 200, 0, 200, ''],
  ['500 points', 500, 0, 500, 'birthdays & groups'],
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    card_no TEXT,
    holder_name TEXT,
    phone TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    deposit REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',      -- active | blocked | returned
    issued_at TEXT NOT NULL,
    last_used_at TEXT,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    zone TEXT,
    mode TEXT NOT NULL DEFAULT 'time',           -- time (1/2/3 min) | game (per play)
    price_1 INTEGER, price_2 INTEGER, price_3 INTEGER,
    price_game INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    webhook_start TEXT,                           -- optional URL hit when a play starts (relay / smart plug)
    webhook_stop TEXT,                            -- optional URL hit when the play ends
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    bonus INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    opening_cash REAL NOT NULL DEFAULT 0,
    closing_cash REAL,
    expected_cash REAL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,          -- ISSUE | TOPUP | PLAY | ADJUST | RETURN | BLOCK | UNBLOCK
    card_id INTEGER REFERENCES cards(id),
    machine_id INTEGER REFERENCES machines(id),
    package_id INTEGER REFERENCES packages(id),
    shift_id INTEGER REFERENCES shifts(id),
    credits INTEGER NOT NULL DEFAULT 0,   -- change to the card balance (+ bought, - used/refunded)
    amount REAL NOT NULL DEFAULT 0,       -- money for credits (+ received, - refunded)
    deposit REAL NOT NULL DEFAULT 0,      -- deposit money (+ received, - refunded)
    method TEXT,                          -- cash | card | online
    minutes INTEGER,
    balance_after INTEGER,
    staff TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_tx_ts ON transactions(ts);
  CREATE INDEX IF NOT EXISTS ix_tx_card ON transactions(card_id);
  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    machine_id INTEGER NOT NULL REFERENCES machines(id),
    tx_id INTEGER REFERENCES transactions(id),
    minutes INTEGER NOT NULL DEFAULT 0,
    credits INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'  -- running | done | stopped
  );
  CREATE INDEX IF NOT EXISTS ix_plays_machine ON plays(machine_id, status);
  `);
}

function seed(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);

  const nMachines = db.prepare('SELECT COUNT(*) AS n FROM machines').get().n;
  if (nMachines === 0) {
    const im = db.prepare(`INSERT INTO machines(code,name,zone,mode,price_1,price_2,price_3,price_game,sort,note)
                           VALUES (?,?,?,?,?,?,?,?,?,?)`);
    SEED_MACHINES.forEach((m, i) => im.run(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], i, m[8]));
  }
  const nPackages = db.prepare('SELECT COUNT(*) AS n FROM packages').get().n;
  if (nPackages === 0) {
    const ip = db.prepare('INSERT INTO packages(name,credits,bonus,price,sort,note) VALUES (?,?,?,?,?,?)');
    SEED_PACKAGES.forEach((p, i) => ip.run(p[0], p[1], p[2], p[3], i, p[4]));
  }
}

export function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
