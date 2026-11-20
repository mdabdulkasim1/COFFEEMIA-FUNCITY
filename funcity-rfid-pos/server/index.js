// Fun City RFID POS server: static UI + JSON API, zero dependencies (Node >= 22.5).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import * as api from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const DB_PATH = process.env.FUNCITY_DB || join(__dirname, '..', 'data', 'funcity.db');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

export function createApp(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  const timers = new Map(); // play id -> timeout for the stop webhook

  // --- optional relay webhooks (smart plug / ESP relay on each ride) ---
  function ping(url, label) {
    if (!url) return;
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) }).catch(e => console.warn(`[webhook] ${label} failed: ${e.message}`));
  }
  function scheduleStop(play, machine) {
    if (timers.has(play.id)) clearTimeout(timers.get(play.id));
    const ms = Math.max(0, new Date(play.ends_at).getTime() - Date.now());
    const t = setTimeout(() => { timers.delete(play.id); api.finishExpired(db); ping(machine.webhook_stop, `${machine.code} stop`); }, ms);
    t.unref?.();
    timers.set(play.id, t);
  }
  // Re-arm stop webhooks for plays still running after a restart.
  for (const m of api.listMachines(db)) {
    const p = api.activePlay(db, m.id);
    if (p && m.webhook_stop) scheduleStop(p, m);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new api.ApiError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new api.ApiError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
  const needPin = req => api.checkPin(db, req.headers['x-admin-pin']);

  // --- routes: [method, regex, handler(req, params, query, body)] ---
  const routes = [
    ['GET', /^\/api\/bootstrap$/, () => ({ settings: api.publicSettings(db), machines: api.listMachines(db), packages: api.listPackages(db),
      shift: api.currentShift(db), server_time: new Date().toISOString() })],
    ['GET', /^\/api\/settings$/, () => api.publicSettings(db)],
    ['PUT', /^\/api\/settings$/, (req, p, q, b) => { needPin(req); return api.updateSettings(db, b); }],
    ['POST', /^\/api\/pin\/check$/, (req, p, q, b) => { api.checkPin(db, b.pin); return { ok: true }; }],

    ['GET', /^\/api\/shifts\/current$/, () => api.currentShift(db)],
    ['GET', /^\/api\/shifts$/, () => api.listShifts(db)],
    ['POST', /^\/api\/shifts\/open$/, (req, p, q, b) => api.openShift(db, b)],
    ['POST', /^\/api\/shifts\/close$/, (req, p, q, b) => api.closeShift(db, b)],

    ['GET', /^\/api\/machines$/, () => api.listMachines(db)],
    ['POST', /^\/api\/machines$/, (req, p, q, b) => { needPin(req); return api.saveMachine(db, b); }],
    ['GET', /^\/api\/packages$/, () => api.listPackages(db)],
    ['POST', /^\/api\/packages$/, (req, p, q, b) => { needPin(req); return api.savePackage(db, b); }],

    ['GET', /^\/api\/cards$/, (req, p, q) => api.searchCards(db, q.get('q') ?? '')],
    ['GET', /^\/api\/cards\/([^/]+)$/, (req, p) => api.getCard(db, p[0])],
    ['POST', /^\/api\/cards\/issue$/, (req, p, q, b) => api.issueCard(db, b)],
    ['POST', /^\/api\/cards\/([^/]+)\/topup$/, (req, p, q, b) => api.topUp(db, p[0], b)],
    ['POST', /^\/api\/cards\/([^/]+)\/adjust$/, (req, p, q, b) => { needPin(req); return api.adjustCredits(db, p[0], b); }],
    ['POST', /^\/api\/cards\/([^/]+)\/block$/, (req, p, q, b) => api.setBlocked(db, p[0], true, b)],
    ['POST', /^\/api\/cards\/([^/]+)\/unblock$/, (req, p, q, b) => { needPin(req); return api.setBlocked(db, p[0], false, b); }],
    ['POST', /^\/api\/cards\/([^/]+)\/return$/, (req, p, q, b) => { needPin(req); return api.returnCard(db, p[0], b); }],

    ['POST', /^\/api\/play$/, (req, p, q, b) => {
      const r = api.startPlay(db, b);
      if (!r.extended) ping(r.machine.webhook_start, `${r.machine.code} start`);
      if (r.machine.webhook_stop) scheduleStop(r.play, r.machine);
      return r;
    }],
    ['POST', /^\/api\/play\/(\d+)\/stop$/, (req, p) => { needPin(req); const pl = api.stopPlay(db, p[0]); return pl; }],
    ['GET', /^\/api\/machines\/([^/]+)\/active$/, (req, p) => {
      const m = api.getMachineByCode(db, p[0]);
      return { machine: m, play: api.activePlay(db, m.id), server_time: new Date().toISOString() };
    }],
    ['GET', /^\/api\/live$/, () => ({ board: api.liveBoard(db), server_time: new Date().toISOString() })],

    ['GET', /^\/api\/reports\/summary$/, (req, p, q) => api.reportSummary(db, { from: q.get('from'), to: q.get('to') })],
    ['GET', /^\/api\/reports\/transactions$/, (req, p, q, b, res) => {
      const rows = api.reportTransactions(db, { from: q.get('from'), to: q.get('to'), type: q.get('type'), limit: q.get('limit') ?? 2000 });
      if (q.get('format') === 'csv') {
        const s = api.settings(db);
        const name = `funcity-transactions-${(q.get('from') ?? '').slice(0, 10) || 'today'}.csv`;
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
        res.end('﻿' + api.toCsv(rows, s.company_code));
        return undefined;
      }
      return rows;
    }],
  ];

  async function serveStatic(req, res, pathname) {
    let file = pathname === '/' ? '/index.html' : pathname;
    if (file === '/station') file = '/station.html';
    const full = normalize(join(PUBLIC, file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not file');
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      createReadStream(full).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (!m) continue;
        const body = method === 'GET' ? {} : await readBody(req);
        const out = await handler(req, m.slice(1).map(decodeURIComponent), url.searchParams, body, res);
        if (out !== undefined) json(res, 200, out);
        return;
      }
      json(res, 404, { error: 'No such API route' });
    } catch (e) {
      if (e instanceof api.ApiError) return json(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      json(res, 500, { error: 'Server error: ' + e.message });
    }
  });

  return { server, db, close: () => { for (const t of timers.values()) clearTimeout(t); server.close(); db.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp();
  app.server.listen(PORT, HOST, () => {
    console.log(`Fun City RFID POS running`);
    console.log(`  Counter POS : http://localhost:${PORT}/`);
    console.log(`  Station     : http://localhost:${PORT}/station?machine=C1  (replace C1 with the machine code)`);
    console.log(`  Database    : ${DB_PATH}`);
  });
}
