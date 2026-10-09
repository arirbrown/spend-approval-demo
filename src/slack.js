// Mock Slack intake. There is no real Slack connection — messages are seeded
// rows — but the processing loop mirrors how a real integration works:
//   1. Parse the message into structured fields (never invent what's missing)
//   2. Post back the exact change that would be made
//   3. Wait for a human confirmation
//   4. File it through the SAME request pipeline as the web form
//   5. Report the outcome (tier, approver, receipt) back in the channel

import { CONFIG, PEOPLE, CONTRACT, CONTRACT_LABELS } from './config.js';
import { resolveTier, validateRequest } from './tiers.js';
import { submitRequest, relatedSpend } from './service.js';
import { nowMs } from './clock.js';

export const BOT = 'devin';

export function postBot(db, text, atMs = nowMs(db)) {
  db.prepare(
    "INSERT INTO slack_messages (author, is_bot, text, ts, status) VALUES (?,1,?,?,'posted')"
  ).run(BOT, text, new Date(atMs).toISOString());
}

export function listMessages(db) {
  return db.prepare('SELECT * FROM slack_messages ORDER BY ts, id').all()
    .map(m => ({ ...m, parsed: m.parsed ? JSON.parse(m.parsed) : null }));
}

// ---------- parsing ----------

const DIM = {
  region: {
    US: /\b(us|u\.s\.|united states|stateside|nyc|sf)\b/i,
    Europe: /\b(eu|europe|emea|berlin|london|paris|nordic|leipzig|dublin)\b/i,
    APAC: /\b(apac|asia|singapore|sydney|tokyo|japan|australia)\b/i,
  },
  channel: {
    'Paid ads': /\b(paid|ads\b|advert|ppc|sem|retarget|search ads|social ads)/i,
    Events: /\b(event|booth|summit|conference|expo|dinner|meetup|field)/i,
    Sponsorships: /\b(sponsor|podcast|newsletter|broadcast|livestream)/i,
    Agencies: /\b(agenc|retainer|studio|creative|design shop)/i,
  },
  motion: {
    'Self-serve': /\b(self[- ]serve|sign-?ups?|trials?|activation|paid social|paid search)/i,
    Enterprise: /\b(enterprise|pipeline|sqls?|abm|field)/i,
    Brand: /\b(brand|awareness|recall|podcast|broadcast|livestream)/i,
  },
};

function matchBucket(text, buckets) {
  let best = null, bestScore = 1, tied = false;
  for (const b of buckets) {
    if (b.is_reserve) continue;
    const score = ['region', 'channel', 'motion']
      .filter(dim => DIM[dim][b[dim]]?.test(text)).length;
    if (score > bestScore) { best = b; bestScore = score; tied = false; }
    else if (score === bestScore) tied = true;
  }
  return tied || !best ? null : best;
}

// Extract request fields from a plain-English message. Anything not found is
// simply absent — the caller decides whether that's acceptable.
export function parseMessage(text, buckets) {
  const out = {};

  const amt = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s?([km])?\b/i)
    || text.match(/\b([\d,]+(?:\.\d+)?)\s?([km])\b/i);
  if (amt) out.amount = Number(amt[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[amt[2]?.toLowerCase()] ?? 1);

  const ven = text.match(/\bto\s+([\w&.'-]+(?: [\w&.'-]+){0,4}?)\s+for\b/)
    || text.match(/\bvendor\s*:\s*([^\n,;.]+)/i);
  if (ven) out.vendor = ven[1].trim();

  const bucket = matchBucket(text, buckets);
  if (bucket) out.bucketId = bucket.id;

  const goal = text.match(/\bgoal\s*:\s*([^.,;\n]+)/i);
  if (goal) out.goal = goal[1].trim();

  const met = text.match(/\bmetric\s*:\s*([^.,;→\n]+)/i);
  if (met) out.successMetric = met[1].trim();

  const tgt = text.match(/(?:→|->|target\s*[:=])\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (tgt) out.successTarget = Number(tgt[1].replace(/,/g, ''));

  if (/\b(annual|multi[- ]quarter|longer than (a |one )?quarter|year[- ]long|\d+[- ]month)\b/i.test(text))
    out.contractLength = CONTRACT.MULTI_QUARTER;
  else if (/\b(one[- ]time|one[- ]off)\b/i.test(text))
    out.contractLength = CONTRACT.ONE_TIME;
  else if (/\b(quarter|up to (a |one )?quarter)\b/i.test(text))
    out.contractLength = CONTRACT.UP_TO_QUARTER;

  const can = text.match(/\bcancell?able\s*:?\s*(yes|no|true|false)\b/i);
  if (can) out.cancellable = /yes|true/i.test(can[1]);
  else if (/\bnon[- ]?cancell?able|can'?t be cancelled\b/i.test(text)) out.cancellable = false;
  else if (/\bcancell?able\b/i.test(text)) out.cancellable = true;

  return out;
}

// ---------- processing loop ----------

const money = n => `$${Math.round(n).toLocaleString('en-US')}`;

function bucketRemaining(db, bucketId) {
  return db.prepare(
    'SELECT budget - COALESCE((SELECT SUM(committed) FROM ledger WHERE bucket_id = ?), 0) r FROM buckets WHERE id = ?'
  ).get(bucketId, bucketId).r;
}

function describe(fields, db) {
  const bucket = db.prepare('SELECT * FROM buckets WHERE id = ?').get(fields.bucketId);
  const lines = [
    `• Vendor: ${fields.vendor}`,
    `• Amount: ${money(fields.amount)}`,
    `• Bucket: ${bucket.name} (${money(bucketRemaining(db, bucket.id))} remaining)`,
    `• Goal: ${fields.goal}`,
    `• Metric: ${fields.successMetric} → ${Number(fields.successTarget).toLocaleString()}`,
    `• Contract: ${CONTRACT_LABELS[fields.contractLength]}${fields.cancellable ? ' · cancellable' : ' · not cancellable'}`,
  ];
  return { bucket, lines };
}

// Step 1+2: parse the message and post the exact change for confirmation.
export function processMessage(db, id) {
  const msg = db.prepare('SELECT * FROM slack_messages WHERE id = ?').get(id);
  if (!msg || msg.is_bot) return { error: 'Message not found.' };
  if (msg.status !== 'unprocessed') return { error: `Message already ${msg.status}.` };

  const atMs = nowMs(db);
  const buckets = db.prepare('SELECT * FROM buckets').all();
  const fields = parseMessage(msg.text, buckets);
  const candidate = {
    requester: msg.author, description: msg.text.slice(0, 300), source: 'slack', ...fields,
  };
  const errors = validateRequest(candidate);

  if (errors.length) {
    db.prepare("UPDATE slack_messages SET status = 'needs_info', parsed = ? WHERE id = ?")
      .run(JSON.stringify(fields), id);
    postBot(db,
      `@${msg.author} I couldn't file this one — I don't invent missing fields, so a human needs to fill the gaps:\n` +
      errors.map(e => `• ${e}`).join('\n') +
      `\n\nFormat: "spend request: $X to VENDOR for BUCKET — goal: ..., metric: ... → TARGET, contract: one-time|up to one quarter|multi-quarter, cancellable: yes|no"`,
      atMs + 1000);
    return { status: 'needs_info', errors };
  }

  // Show the exact change before making it — including where it will route.
  const { lines } = describe(fields, db);
  const related = relatedSpend(db, fields.bucketId, msg.author, fields.vendor, atMs);
  const { tier, reasons, splitFlag } = resolveTier({
    amount: fields.amount,
    bucketRemaining: bucketRemaining(db, fields.bucketId),
    contractLength: fields.contractLength,
    relatedSpend: related,
  });
  const route = tier === 1 ? 'auto-approve and commit immediately'
    : tier === 2 ? `queue for ${db.prepare('SELECT lead FROM buckets WHERE id=?').get(fields.bucketId).lead} (bucket lead)`
    : `queue for ${PEOPLE.HEAD} (Head of Marketing), then ${PEOPLE.FINANCE} (Finance)`;

  db.prepare("UPDATE slack_messages SET status = 'awaiting_confirmation', parsed = ? WHERE id = ?")
    .run(JSON.stringify(fields), id);
  postBot(db,
    `@${msg.author} Here's the exact request I'd file:\n` + lines.join('\n') +
    `\n\nIt would ${route}.` +
    (splitFlag ? `\n⚑ FLAG: ${splitFlag}` : '') +
    `\nConfirm in the app to file it — nothing gets submitted on the first read.`,
    atMs + 1000);
  return { status: 'awaiting_confirmation', fields, tier };
}

// Step 3+4+5: on confirmation, file through the same pipeline and report back.
export function confirmMessage(db, id) {
  const msg = db.prepare('SELECT * FROM slack_messages WHERE id = ?').get(id);
  if (!msg || msg.is_bot) return { error: 'Message not found.' };
  if (msg.status !== 'awaiting_confirmation') return { error: `Message is ${msg.status}, not awaiting confirmation.` };

  const atMs = nowMs(db);
  const fields = JSON.parse(msg.parsed);
  const out = submitRequest(db, {
    requester: msg.author, description: msg.text.slice(0, 300),
    source: 'slack', ...fields,
  }, atMs);
  if (out.errors) {
    db.prepare("UPDATE slack_messages SET status = 'needs_info' WHERE id = ?").run(id);
    return { status: 'needs_info', errors: out.errors };
  }

  const r = out.request;
  db.prepare("UPDATE slack_messages SET status = 'filed', request_id = ? WHERE id = ?").run(r.id, id);
  let reply;
  if (out.ledger) {
    reply = `Filed — request #${r.id} auto-approved. Committed ${money(r.amount)} to ${r.bucket_name}. ` +
      `Receipt ${out.ledger.entry.receipt_id} ${out.ledger.verified ? '(read-back verified ✓)' : '(READ-BACK MISMATCH — flagging a human)'}.`;
  } else {
    reply = `Filed — request #${r.id} is Tier ${r.tier}, waiting on ${r.next_approver}. ` +
      `I'll post here when it's decided.` +
      (r.split_flag ? `\n⚑ FLAG: ${r.split_flag}` : '');
  }
  postBot(db, `@${msg.author} ${reply}`, atMs + 1000);
  return { status: 'filed', request: r, ledger: out.ledger };
}

// Called by the server after approve/reject so the channel hears the outcome.
export function narrateDecision(db, req, ledger, rejectedActor = null) {
  if (req.source !== 'slack') return;
  if (rejectedActor) {
    postBot(db, `Request #${req.id} (${req.vendor}, ${money(req.amount)}) was rejected by ${rejectedActor}. Nothing committed.`);
  } else if (req.status === 'approved' && ledger) {
    postBot(db,
      `Request #${req.id} (${req.vendor}, ${money(req.amount)}) approved by ${ledger.entry.approver} → committed to ${req.bucket_name}. ` +
      `Receipt ${ledger.entry.receipt_id} ${ledger.verified ? '(read-back verified ✓)' : '(READ-BACK MISMATCH)'}.`);
  } else if (req.required_role === 'finance') {
    postBot(db, `Request #${req.id} approved by ${PEOPLE.HEAD} → now waiting on ${PEOPLE.FINANCE} (Finance).`);
  }
}
