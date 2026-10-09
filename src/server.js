import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { CONFIG, PEOPLE, CONTRACT_LABELS } from './config.js';
import * as svc from './service.js';
import { buildDigest } from './digest.js';
import { reseed } from './seed.js';
import { listMessages, processMessage, confirmMessage, narrateDecision } from './slack.js';
import { nowMs, getClockOffsetMs, setClockOffsetMs } from './clock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const db = openDb();

if (db.prepare('SELECT COUNT(*) c FROM buckets').get().c === 0) {
  const counts = reseed(db);
  console.log(`Seeded ${counts.buckets} buckets, ${counts.requests} requests, ${counts.ledger} ledger entries.`);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function buildState() {
  const atMs = nowMs(db);
  const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC, id DESC').all()
    .map(r => svc.presentRequest(db, r, atMs));
  const ledger = db.prepare(
    `SELECT l.*, b.name bucket_name, r.vendor, r.description request_description
     FROM ledger l JOIN buckets b ON b.id = l.bucket_id JOIN requests r ON r.id = l.request_id
     ORDER BY l.date DESC, l.id DESC`
  ).all();
  return {
    now: new Date(atMs).toISOString(),
    clockOffsetMs: getClockOffsetMs(db),
    config: { ...CONFIG, people: PEOPLE, contractLabels: CONTRACT_LABELS },
    buckets: svc.listBuckets(db),
    requests,
    ledger,
    slackMessages: listMessages(db),
    digest: buildDigest(db, atMs),
  };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, buildState());
    }
    if (req.method === 'POST' && path === '/api/requests') {
      const out = svc.submitRequest(db, await readBody(req));
      return sendJson(res, out.errors ? 422 : 201, out);
    }
    const action = path.match(/^\/api\/requests\/(\d+)\/(approve|reject)$/);
    if (req.method === 'POST' && action) {
      const out = (action[2] === 'approve' ? svc.approveRequest : svc.rejectRequest)(db, Number(action[1]));
      if (out.error) return sendJson(res, 400, out);
      if (action[2] === 'approve') narrateDecision(db, out.request, out.ledger);
      else {
        const last = db.prepare("SELECT actor FROM approvals WHERE request_id = ? ORDER BY id DESC LIMIT 1")
          .get(out.request.id);
        narrateDecision(db, out.request, null, last?.actor);
      }
      return sendJson(res, 200, out);
    }
    const slackAct = path.match(/^\/api\/slack\/(\d+)\/(process|confirm)$/);
    if (req.method === 'POST' && slackAct) {
      const out = (slackAct[2] === 'process' ? processMessage : confirmMessage)(db, Number(slackAct[1]));
      return sendJson(res, out.error ? 400 : 200, out);
    }
    const actual = path.match(/^\/api\/ledger\/(\d+)\/actual$/);
    if (req.method === 'POST' && actual) {
      const out = svc.recordActual(db, Number(actual[1]), Number((await readBody(req)).actual));
      return sendJson(res, out.error ? 400 : 200, out);
    }
    if (req.method === 'POST' && path === '/api/clock') {
      const body = await readBody(req);
      setClockOffsetMs(db, body.reset ? 0 : getClockOffsetMs(db) + Number(body.addMs || 0));
      return sendJson(res, 200, buildState());
    }
    if (req.method === 'POST' && path === '/api/reset') {
      reseed(db);
      return sendJson(res, 200, buildState());
    }
    if (req.method === 'GET') {
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (['index.html', 'app.js', 'styles.css'].includes(file)) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css';
        res.writeHead(200, { 'content-type': type });
        return res.end(await readFile(join(pub, file)));
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`Spend workflow demo running at http://localhost:${PORT}`));
