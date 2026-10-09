import { CONFIG, PEOPLE } from './config.js';
import { resolveTier, validateRequest } from './tiers.js';
import { now, nowMs } from './clock.js';

// ---------- reads ----------

export function listBuckets(db) {
  const stats = new Map(
    db.prepare(
      'SELECT bucket_id, COALESCE(SUM(committed),0) committed, COALESCE(SUM(actual),0) actual ' +
      'FROM ledger GROUP BY bucket_id'
    ).all().map(s => [s.bucket_id, s])
  );
  return db.prepare('SELECT * FROM buckets ORDER BY id').all().map(b => {
    const s = stats.get(b.id) || { committed: 0, actual: 0 };
    return { ...b, committed: s.committed, actual: s.actual, remaining: b.budget - s.committed };
  });
}

export function getRequest(db, id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

// Combined spend in a bucket over the split window from the same requester
// OR the same vendor — the input to the splitting check.
export function relatedSpend(db, bucketId, requester, vendor, atMs) {
  const since = new Date(atMs - CONFIG.SPLIT_WINDOW_DAYS * 86400e3).toISOString();
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount),0) total FROM requests
     WHERE bucket_id = ? AND status IN ('pending','approved') AND created_at >= ?
       AND (LOWER(requester) = LOWER(?) OR LOWER(vendor) = LOWER(?))`
  ).get(bucketId, since, requester, vendor);
  return row.total;
}

// A pending Tier 2 request left alone longer than ESCALATION_HOURS escalates
// to the head of marketing. Computed on read so the demo clock drives it.
export function isEscalated(req, atMs) {
  return req.status === 'pending' && req.tier === 2 &&
    atMs - Date.parse(req.created_at) > CONFIG.ESCALATION_HOURS * 3600e3;
}

export function presentRequest(db, req, atMs) {
  const bucket = db.prepare('SELECT name, lead FROM buckets WHERE id = ?').get(req.bucket_id);
  const escalated = isEscalated(req, atMs);
  let nextApprover = null;
  if (req.status === 'pending') {
    if (req.tier === 2) {
      nextApprover = escalated
        ? `${PEOPLE.HEAD} (Head of Marketing — escalated)`
        : `${bucket.lead} (bucket lead)`;
    } else {
      nextApprover = req.required_role === 'finance'
        ? `${PEOPLE.FINANCE} (Finance)`
        : `${PEOPLE.HEAD} (Head of Marketing)`;
    }
  }
  return {
    ...req,
    bucket_name: bucket.name,
    tier_reasons: JSON.parse(req.tier_reasons || '[]'),
    escalated,
    next_approver: nextApprover,
    age_hours: Math.max(0, Math.round((atMs - Date.parse(req.created_at)) / 3600e3)),
  };
}

// ---------- writes ----------

export function submitRequest(db, body, atMs = nowMs(db)) {
  const errors = validateRequest(body);
  if (errors.length) return { errors };

  const bucket = db.prepare('SELECT * FROM buckets WHERE id = ?').get(Number(body.bucketId));
  if (!bucket) return { errors: ['Unknown bucket.'] };

  const at = new Date(atMs).toISOString();
  const amount = Number(body.amount);
  const requester = body.requester.trim();
  const vendor = body.vendor.trim();
  const committed = db.prepare(
    'SELECT COALESCE(SUM(committed),0) s FROM ledger WHERE bucket_id = ?'
  ).get(bucket.id).s;
  const remaining = bucket.budget - committed;

  const related = relatedSpend(db, bucket.id, requester, vendor, atMs);
  const { tier, reasons, splitFlag } = resolveTier({
    amount,
    bucketRemaining: remaining,
    contractLength: body.contractLength,
    relatedSpend: related,
  });

  const status = tier === 1 ? 'approved' : 'pending';
  const requiredRole = tier === 1 ? null : tier === 2 ? 'lead' : 'head_of_marketing';
  const spendDate = body.spendDate ? new Date(body.spendDate).toISOString() : null;

  const info = db.prepare(
    `INSERT INTO requests
     (requester, bucket_id, vendor, amount, description, goal, success_metric,
      success_target, contract_length, cancellable, spend_date, tier, status,
      source, split_flag, tier_reasons, required_role, decided_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    requester, bucket.id, vendor, amount, body.description?.trim() || '',
    body.goal.trim(), body.successMetric.trim(), Number(body.successTarget),
    body.contractLength, body.cancellable ? 1 : 0, spendDate, tier, status,
    body.source === 'slack' ? 'slack' : 'web',
    splitFlag, JSON.stringify(reasons), requiredRole, tier === 1 ? at : null, at
  );
  const id = Number(info.lastInsertRowid);

  let ledger = null;
  if (tier === 1) {
    db.prepare(
      'INSERT INTO approvals (request_id, actor, role, action, created_at) VALUES (?,?,?,?,?)'
    ).run(id, 'Auto-approval', 'auto', 'approved', at);
    ledger = commitToLedger(db, id);
  }
  return { request: presentRequest(db, getRequest(db, id), atMs), ledger };
}

// Write a ledger entry for an approved request, then read it back and confirm
// the stored values match what we intended to write.
export function commitToLedger(db, requestId) {
  const req = getRequest(db, requestId);
  const actors = db.prepare(
    "SELECT actor FROM approvals WHERE request_id = ? AND action = 'approved' ORDER BY id"
  ).all(requestId).map(r => r.actor);
  const approver = actors.join(' + ') || 'Auto-approval';
  const n = db.prepare('SELECT COUNT(*) n FROM ledger').get().n + 1;
  const receiptId = `RCP-2026-${String(n).padStart(4, '0')}`;
  const date = req.spend_date || req.decided_at || now(db).toISOString();

  const info = db.prepare(
    `INSERT INTO ledger (request_id, receipt_id, bucket_id, committed, actual, approver, verified, mismatch, date)
     VALUES (?,?,?,?,0,?,0,NULL,?)`
  ).run(requestId, receiptId, req.bucket_id, req.amount, approver, date);
  return verifyEntry(db, Number(info.lastInsertRowid));
}

// Read-back verification: the stored row must match the source request.
export function verifyEntry(db, entryId) {
  const entry = db.prepare('SELECT * FROM ledger WHERE id = ?').get(entryId);
  const req = getRequest(db, entry.request_id);
  const mismatches = [];
  if (!req) mismatches.push(`request ${entry.request_id} not found`);
  else {
    if (entry.bucket_id !== req.bucket_id)
      mismatches.push(`bucket_id: stored ${entry.bucket_id}, expected ${req.bucket_id}`);
    if (Math.abs(entry.committed - req.amount) > 0.005)
      mismatches.push(`committed: stored ${entry.committed}, expected ${req.amount}`);
  }
  if (!entry.receipt_id) mismatches.push('receipt_id missing');
  if (!entry.approver) mismatches.push('approver missing');
  if (!entry.date) mismatches.push('date missing');
  db.prepare('UPDATE ledger SET verified = ?, mismatch = ? WHERE id = ?')
    .run(mismatches.length ? 0 : 1, mismatches.join('; ') || null, entryId);
  return {
    entry: db.prepare('SELECT * FROM ledger WHERE id = ?').get(entryId),
    verified: mismatches.length === 0,
    mismatches,
  };
}

function currentApprover(db, req, atMs) {
  const bucket = db.prepare('SELECT lead FROM buckets WHERE id = ?').get(req.bucket_id);
  if (req.tier === 2) {
    return isEscalated(req, atMs)
      ? { role: 'head_of_marketing', actor: PEOPLE.HEAD }
      : { role: 'lead', actor: bucket.lead };
  }
  return req.required_role === 'finance'
    ? { role: 'finance', actor: PEOPLE.FINANCE }
    : { role: 'head_of_marketing', actor: PEOPLE.HEAD };
}

export function approveRequest(db, id) {
  const req = getRequest(db, id);
  if (!req) return { error: 'Request not found.' };
  if (req.status !== 'pending') return { error: `Request is already ${req.status}.` };

  const atMs = nowMs(db);
  const at = new Date(atMs).toISOString();
  const { role, actor } = currentApprover(db, req, atMs);
  db.prepare(
    'INSERT INTO approvals (request_id, actor, role, action, created_at) VALUES (?,?,?,?,?)'
  ).run(id, actor, role, 'approved', at);

  // Tier 3 is sequential: head of marketing first, then finance.
  if (req.tier === 3 && role === 'head_of_marketing') {
    db.prepare("UPDATE requests SET required_role = 'finance' WHERE id = ?").run(id);
    return {
      request: presentRequest(db, getRequest(db, id), atMs),
      message: `Approved by ${actor}. Awaiting ${PEOPLE.FINANCE} (Finance).`,
    };
  }

  db.prepare("UPDATE requests SET status = 'approved', required_role = NULL, decided_at = ? WHERE id = ?")
    .run(at, id);
  const ledger = commitToLedger(db, id);
  return { request: presentRequest(db, getRequest(db, id), atMs), ledger };
}

export function rejectRequest(db, id) {
  const req = getRequest(db, id);
  if (!req) return { error: 'Request not found.' };
  if (req.status !== 'pending') return { error: `Request is already ${req.status}.` };

  const atMs = nowMs(db);
  const { role, actor } = currentApprover(db, req, atMs);
  db.prepare(
    'INSERT INTO approvals (request_id, actor, role, action, created_at) VALUES (?,?,?,?,?)'
  ).run(id, actor, role, 'rejected', new Date(atMs).toISOString());
  db.prepare("UPDATE requests SET status = 'rejected', required_role = NULL, decided_at = ? WHERE id = ?")
    .run(new Date(atMs).toISOString(), id);
  return { request: presentRequest(db, getRequest(db, id), atMs) };
}

export function recordActual(db, ledgerId, actual) {
  if (!Number.isFinite(actual) || actual < 0) return { error: 'Actual must be a non-negative number.' };
  const entry = db.prepare('SELECT * FROM ledger WHERE id = ?').get(ledgerId);
  if (!entry) return { error: 'Ledger entry not found.' };
  db.prepare('UPDATE ledger SET actual = ? WHERE id = ?').run(actual, ledgerId);
  return { entry: db.prepare('SELECT * FROM ledger WHERE id = ?').get(ledgerId) };
}
