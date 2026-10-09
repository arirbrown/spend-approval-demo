import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parseMessage, processMessage, confirmMessage, BOT } from '../src/slack.js';
import { CONTRACT } from '../src/config.js';

function freshDb() {
  const db = openDb(':memory:');
  const ins = db.prepare(
    'INSERT INTO buckets (name, motion, region, channel, owner, lead, budget, metric, is_reserve) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  ins.run('Self-serve · US · Paid ads', 'Self-serve', 'US', 'Paid ads', 'Dana Reyes', 'Alex Kim', 420_000, 'Signups', 0);
  ins.run('Brand · US · Sponsorships', 'Brand', 'US', 'Sponsorships', 'Chloe Dubois', 'Sofia Marino', 272_000, 'Recall', 0);
  ins.run('Self-serve · APAC · Agencies', 'Self-serve', 'APAC', 'Agencies', 'Aiko Tanaka', 'Kenji Sato', 150_000, 'Signups', 0);
  ins.run('Brand · Europe · Agencies', 'Brand', 'Europe', 'Agencies', 'Sam Okafor', 'Ingrid Falk', 160_000, 'Recall', 0);
  db.prepare('INSERT INTO slack_messages (author, is_bot, text, ts, status) VALUES (?,0,?,?,?)')
    .run('Elena Petrova',
      'spend request: $22k to Nordic Content Co for the EU agency retainer — goal: three extra campaign concepts before November, metric: aided recall → 4, contract: up to one quarter, cancellable: yes',
      new Date().toISOString(), 'unprocessed');
  db.prepare('INSERT INTO slack_messages (author, is_bot, text, ts, status) VALUES (?,0,?,?,?)')
    .run('Aiko Tanaka', 'can I get like $30k for the tokyo agency thing?', new Date().toISOString(), 'unprocessed');
  return db;
}

const buckets = db => db.prepare('SELECT * FROM buckets').all();

test('parser extracts amount with k suffix', () => {
  const p = parseMessage('spend request: $22k to X for EU ads', []);
  assert.equal(p.amount, 22_000);
});

test('parser extracts amount with m suffix and commas', () => {
  assert.equal(parseMessage('$1.5m to X for Y', []).amount, 1_500_000);
  assert.equal(parseMessage('$45,000 to X for Y', []).amount, 45_000);
});

test('parser extracts vendor between "to" and "for"', () => {
  const p = parseMessage('spend request: $22k to Nordic Content Co for the EU agency retainer', []);
  assert.equal(p.vendor, 'Nordic Content Co');
});

test('parser maps message to the right bucket by keyword overlap', () => {
  const db = freshDb();
  const p = parseMessage('spend request: $22k to Nordic Content Co for the EU agency retainer — metric: aided recall → 4', buckets(db));
  assert.equal(p.bucketId, 4); // Brand · Europe · Agencies
});

test('parser reads contract length and cancellability', () => {
  const db = freshDb();
  const p = parseMessage('x — contract: up to one quarter, cancellable: no', buckets(db));
  assert.equal(p.contractLength, CONTRACT.UP_TO_QUARTER);
  assert.equal(p.cancellable, false);
  const p2 = parseMessage('x, annual contract, cancellable: yes', buckets(db));
  assert.equal(p2.contractLength, CONTRACT.MULTI_QUARTER);
  assert.equal(p2.cancellable, true);
});

test('processMessage posts a preview and moves to awaiting_confirmation', () => {
  const db = freshDb();
  const out = processMessage(db, 1);
  assert.equal(out.status, 'awaiting_confirmation');
  const msg = db.prepare('SELECT * FROM slack_messages WHERE id = 1').get();
  assert.equal(msg.status, 'awaiting_confirmation');
  assert.ok(JSON.parse(msg.parsed).vendor);
  const bot = db.prepare('SELECT text FROM slack_messages WHERE is_bot = 1 ORDER BY id DESC LIMIT 1').get();
  assert.ok(bot.text.includes('exact request'));
  assert.ok(bot.text.includes('queue') || bot.text.includes('auto-approve'));
});

test('unparseable message is flagged needs_info, not guessed', () => {
  const db = freshDb();
  const out = processMessage(db, 2);
  assert.equal(out.status, 'needs_info');
  const bot = db.prepare('SELECT text FROM slack_messages WHERE is_bot = 1 ORDER BY id DESC LIMIT 1').get();
  assert.ok(bot.text.includes("don't invent"));
});

test('confirmMessage files through the same pipeline and reports the receipt', () => {
  const db = freshDb();
  processMessage(db, 1);
  const out = confirmMessage(db, 1);
  assert.equal(out.status, 'filed');
  assert.equal(out.request.source, 'slack');
  assert.equal(out.request.status, 'approved'); // $22k within budget -> Tier 1
  assert.equal(out.ledger.verified, true);
  const bot = db.prepare('SELECT text FROM slack_messages WHERE is_bot = 1 ORDER BY id DESC LIMIT 1').get();
  assert.ok(bot.text.includes('RCP-2026-'));
});

test('cannot confirm a message that was never processed', () => {
  const db = freshDb();
  db.prepare('INSERT INTO slack_messages (author, is_bot, text, ts, status) VALUES (?,0,?,?,?)')
    .run('X', 'spend request: $5k to V for US paid ads — goal: g, metric: m → 1, one-time, cancellable: yes',
      new Date().toISOString(), 'unprocessed');
  const out = confirmMessage(db, 3);
  assert.ok(out.error);
});
